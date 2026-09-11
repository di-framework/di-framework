/**
 * Runtime-neutral SQL handle shared by repositories, migrations, actors, and
 * queues. A `SqlDatabase` hides whether the statements run through Bun's
 * `bun:sqlite`, Node's `node:sqlite`, or the `di-framework:sqlite/database`
 * WIT import inside a Wasm component.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back when it throws.
   * All statements on one handle are serialized, including `run`/`query`/`exec`
   * issued outside a transaction. Nested `transaction()` calls on the callback
   * view join the outer one. Same-context statements on the outer handle while
   * a transaction is open still join it; concurrent tasks wait for the lock.
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

/**
 * Builds a `SqlDatabase` on top of a driver, adding serialized transactions
 * and re-entrant nesting.
 */
export function createSqlDatabase(
  driver: SqlDriver,
  options: CreateSqlDatabaseOptions = {},
): SqlDatabase {
  const begin = options.beginStatement ?? 'BEGIN IMMEDIATE';
  const mutex = new AsyncMutex();
  const mutexHeld = new AsyncLocalStorage<true>();
  const activeTransaction = new AsyncLocalStorage<SqlDatabase>();

  const run = async (sql: string, params: unknown[] = []) =>
    normalizeChanges(await driver.run(sql, params));
  const query = async <T = SqlRow>(sql: string, params: unknown[] = []) =>
    (await driver.query(sql, params)) as T[];
  const first = async <T = SqlRow>(sql: string, params: unknown[] = []): Promise<T | null> => {
    if (typeof driver.first === 'function') {
      return ((await driver.first(sql, params)) as T | null | undefined) ?? null;
    }
    const rows = (await driver.query(sql, params)) as T[];
    return rows[0] ?? null;
  };
  const exec = async (sql: string) => {
    await driver.exec(sql);
  };

  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (mutexHeld.getStore() === true) return fn();
    return mutex.run(() => mutexHeld.run(true, fn));
  };

  const transactionView: SqlDatabase = {
    [SQL_DATABASE_BRAND]: true,
    run,
    query,
    first,
    exec,
    transaction: (fn) => fn(transactionView),
  } as SqlDatabase;

  const database: SqlDatabase = {
    [SQL_DATABASE_BRAND]: true,
    run: (sql, params = []) => locked(() => run(sql, params)),
    query: (sql, params = []) => locked(() => query(sql, params)),
    first: (sql, params = []) => locked(() => first(sql, params)),
    exec: (sql) => locked(() => exec(sql)),
    transaction: async <T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> => {
      if (activeTransaction.getStore() === transactionView) {
        return fn(transactionView);
      }
      return locked(async () => {
        await exec(begin);
        try {
          const result = await activeTransaction.run(transactionView, () => fn(transactionView));
          await exec('COMMIT');
          return result;
        } catch (error) {
          try {
            await exec('ROLLBACK');
          } catch {}
          throw error;
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
