/**
 * Runtime-neutral SQL handle shared by repositories, migrations, actors, and
 * queues. A `SqlDatabase` hides whether the statements run through Bun's
 * `bun:sqlite`, Node's `node:sqlite`, or the `di-framework:sqlite/database`
 * WIT import inside a Wasm component.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  contextLock,
  type Guard,
  guardedStatements,
  type Lease,
  leaseGuard,
  type SqlStatementCalls,
} from '../sql-lock';

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back when it throws.
   * All statements on one handle are serialized, including `run`/`query`/`exec`
   * issued outside a transaction. Nested `transaction()` calls on the callback
   * view join the outer one; concurrent tasks wait for the lock.
   *
   * Inside `fn`, prefer the callback view: it joins the transaction from any
   * async context (a worker loop, a pre-created `AsyncResource`, code the
   * AsyncLocalStorage shim of a Wasm guest does not instrument). The outer
   * handle joins only from `fn`'s own async context; from anywhere else it
   * waits for the lock, which deadlocks if `fn` awaits it.
   *
   * Joining ends with the transaction: a continuation that runs afterwards (a
   * timer scheduled inside it, a retained callback view) waits for the lock.
   */
  transaction<T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

/**
 * Shared with `MigrationDatabase` so wrapped handles pass both brand checks.
 */
export const SQL_DATABASE_BRAND = Symbol.for('di-framework.migration-db');

export function isSqlDatabase(value: unknown): value is SqlDatabase {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[SQL_DATABASE_BRAND] === true ||
    (typeof candidate.run === 'function' &&
      typeof candidate.query === 'function' &&
      typeof candidate.first === 'function' &&
      typeof candidate.exec === 'function' &&
      typeof candidate.transaction === 'function')
  );
}

export type SqlRow = Record<string, unknown>;

/**
 * Minimal primitive a `SqlDatabase` is assembled from. Methods may be
 * synchronous (Bun, Node, WIT host calls) or return promises.
 */
export interface SqlDriver {
  run(sql: string, params: unknown[]): { changes?: number } | Promise<{ changes?: number }>;
  query(sql: string, params: unknown[]): SqlRow[] | Promise<SqlRow[]>;
  first?(
    sql: string,
    params: unknown[],
  ): SqlRow | null | undefined | Promise<SqlRow | null | undefined>;
  exec(sql: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** Promise-chain mutex used to serialize transactions on one connection. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface CreateSqlDatabaseOptions {
  /** Statement that opens a transaction. Defaults to `BEGIN IMMEDIATE`. */
  beginStatement?: string;
}

function normalizeChanges(result: { changes?: number | bigint } | undefined | null): {
  changes?: number;
} {
  const changes = result?.changes;
  if (typeof changes === 'number') return { changes };
  if (typeof changes === 'bigint') return { changes: Number(changes) };
  return { changes: undefined };
}

/** A transaction opened by `createSqlDatabase`; its lease is cleared when it ends. */
interface OpenTransaction {
  readonly lease: Lease;
  readonly view: SqlDatabase;
}

/**
 * Builds a `SqlDatabase` on top of a driver, adding serialized transactions
 * and re-entrant nesting.
 */
export function createSqlDatabase(
  driver: SqlDriver,
  options: CreateSqlDatabaseOptions = {},
): SqlDatabase {
  const begin = options.beginStatement ?? 'BEGIN IMMEDIATE';
  const locked = contextLock(new AsyncMutex());
  const activeTransaction = new AsyncLocalStorage<OpenTransaction>();

  const calls: SqlStatementCalls = {
    run: async (sql, params) => normalizeChanges(await driver.run(sql, params)),
    query: async (sql, params) => driver.query(sql, params),
    first: async (sql, params) => {
      if (typeof driver.first === 'function') return (await driver.first(sql, params)) ?? null;
      const rows = await driver.query(sql, params);
      return rows[0] ?? null;
    },
    exec: async (sql) => {
      await driver.exec(sql);
    },
  };
  const statementsVia = (guard: Guard) => ({
    [SQL_DATABASE_BRAND]: true,
    ...guardedStatements(guard, calls),
  });

  // The callback view joins its transaction from any async context while it is
  // open, and takes the lock like the outer handle once it has ended.
  const openTransaction = (): OpenTransaction => {
    const lease: Lease = { active: true };
    const view = {
      ...statementsVia(leaseGuard(lease, locked)),
      transaction: (fn) => (lease.active ? fn(view) : database.transaction(fn)),
    } as SqlDatabase;
    return { lease, view };
  };

  const database: SqlDatabase = {
    ...statementsVia(locked),
    transaction: async <T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> => {
      const current = activeTransaction.getStore();
      if (current?.lease.active) return fn(current.view);
      return locked(async () => {
        const tx = openTransaction();
        try {
          await calls.exec(begin);
          try {
            const result = await activeTransaction.run(tx, () => fn(tx.view));
            await calls.exec('COMMIT');
            return result;
          } catch (error) {
            try {
              await calls.exec('ROLLBACK');
            } catch {}
            throw error;
          }
        } finally {
          tx.lease.active = false;
        }
      });
    },
    close: () => locked(async () => driver.close?.()),
  } as SqlDatabase;

  return database;
}

/**
 * Structural shape of `bun:sqlite`'s `Database` (and test doubles for it).
 * Only `query` is required; `run`/`exec`/`prepare` are used when present.
 */
export interface BunSqliteLike {
  query(sql: string): {
    all(...args: unknown[]): unknown[];
    get?(...args: unknown[]): unknown;
    run?(...args: unknown[]): { changes?: number } | void;
  };
  run?(sql: string, ...args: unknown[]): { changes?: number } | void;
  exec?(sql: string): void;
  close?(): void;
}

/** Adapts a `bun:sqlite` `Database` (or compatible object) to `SqlDatabase`. */
export function wrapBunSqliteDatabase(db: BunSqliteLike): SqlDatabase {
  const driver: SqlDriver = {
    run(sql, params) {
      if (typeof db.run === 'function') {
        return normalizeChanges(db.run(sql, ...params) ?? undefined);
      }
      const statement = db.query(sql);
      if (typeof statement.run !== 'function') {
        throw new Error('Bun SQLite handle does not support run(sql, ...params)');
      }
      return normalizeChanges(statement.run(...params) ?? undefined);
    },
    query(sql, params) {
      return db.query(sql).all(...params) as SqlRow[];
    },
    first(sql, params) {
      const statement = db.query(sql);
      if (typeof statement.get === 'function') {
        return (statement.get(...params) as SqlRow | null | undefined) ?? null;
      }
      const rows = statement.all(...params) as SqlRow[];
      return rows[0] ?? null;
    },
    exec(sql) {
      if (typeof db.exec === 'function') {
        db.exec(sql);
      } else if (typeof db.run === 'function') {
        db.run(sql);
      } else {
        const statement = db.query(sql);
        if (typeof statement.run !== 'function') {
          throw new Error('Bun SQLite handle does not support exec(sql)');
        }
        statement.run();
      }
    },
    close() {
      db.close?.();
    },
  };
  return createSqlDatabase(driver);
}

/** Structural shape of `node:sqlite`'s `DatabaseSync`. */
export interface NodeSqliteLike {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number | bigint };
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  exec(sql: string): void;
  close?(): void;
}

/** Adapts a `node:sqlite` `DatabaseSync` to `SqlDatabase`. */
export function wrapNodeSqliteDatabase(db: NodeSqliteLike): SqlDatabase {
  const driver: SqlDriver = {
    run(sql, params) {
      return normalizeChanges(db.prepare(sql).run(...params));
    },
    query(sql, params) {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    first(sql, params) {
      return (db.prepare(sql).get(...params) as SqlRow | null | undefined) ?? null;
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close?.();
    },
  };
  return createSqlDatabase(driver);
}
