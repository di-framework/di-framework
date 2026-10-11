/**
 * Locking shared by the `SqlDatabase` adapters that serialize one connection.
 * Exported from the package entry for out-of-tree adapter packages.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsyncMutex, SqlRow } from './sqlite/sql-database';

/** Cleared when the lock, transaction, or savepoint it stands for ends. */
export interface Lease {
  active: boolean;
}

/** Runs `fn` under some locking rule. */
export type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A guard that runs `fn` under `mutex`, or directly when the caller's async
 * context already holds it. The holder's lease is cleared on release, so a
 * continuation that outlives the holder (a timer) waits like any other caller.
 */
export function contextLock(mutex: AsyncMutex): Guard {
  const held = new AsyncLocalStorage<Lease>();
  return async (fn) => {
    if (held.getStore()?.active) return fn();
    return mutex.run(async () => {
      const lease: Lease = { active: true };
      try {
        return await held.run(lease, fn);
      } finally {
        lease.active = false;
      }
    });
  };
}

/**
 * The guard for a transaction's callback view: it runs directly while `lease`
 * is active, from any async context, and falls back to `locked` once it ends.
 */
export function leaseGuard(lease: Lease, locked: Guard): Guard {
  return (fn) => (lease.active ? fn() : locked(fn));
}

/** The raw statement calls an adapter makes on its connection. */
export interface SqlStatementCalls {
  run(sql: string, params: unknown[]): Promise<{ changes?: number }>;
  query(sql: string, params: unknown[]): Promise<SqlRow[]>;
  first(sql: string, params: unknown[]): Promise<SqlRow | null>;
  exec(sql: string): Promise<void>;
}

/** `run`/`query`/`first`/`exec` methods that call `calls` through `guard`. */
export function guardedStatements(guard: Guard, calls: SqlStatementCalls) {
  return {
    run: (sql: string, params: unknown[] = []) => guard(() => calls.run(sql, params)),
    query: <T = SqlRow>(sql: string, params: unknown[] = []) =>
      guard(() => calls.query(sql, params) as Promise<T[]>),
    first: <T = SqlRow>(sql: string, params: unknown[] = []) =>
      guard(() => calls.first(sql, params) as Promise<T | null>),
    exec: (sql: string) => guard(() => calls.exec(sql)),
  };
}
