import { detectSqliteBackend, openSqliteDatabase, type SqliteBackend } from '../sqlite/open';
import {
  type BunSqliteLike,
  isSqlDatabase,
  type NodeSqliteLike,
  SQL_DATABASE_BRAND,
  wrapBunSqliteDatabase,
  wrapNodeSqliteDatabase,
} from '../sqlite/sql-database';
import type { MigrationDatabase } from './types';

export const MIGRATION_DB_BRAND = SQL_DATABASE_BRAND;

export function isMigrationDatabase(val: unknown): val is MigrationDatabase {
  return (
    typeof val === 'object' &&
    val !== null &&
    ((val as any)[MIGRATION_DB_BRAND] === true ||
      (typeof (val as any).first === 'function' &&
        typeof (val as any).exec === 'function' &&
        typeof (val as any).query === 'function' &&
        typeof (val as any).run === 'function'))
  );
}

/**
 * Resolves anything migration code accepts as a database into a
 * `MigrationDatabase`:
 *
 * - an existing `MigrationDatabase` / `SqlDatabase` (returned as-is)
 * - a path or `:memory:`, opened with `bun:sqlite`, `node:sqlite`, or the
 *   `di-framework:sqlite/database` Wasm import (`DI_SQLITE_BACKEND=wasm`, or
 *   automatically when no native module is available)
 * - a `bun:sqlite` `Database`, a `node:sqlite` `DatabaseSync`, or a
 *   `SqlStorageAdapter`-like object
 */
export async function createMigrationDatabase(
  input: unknown,
  runtime: SqliteBackend = detectSqliteBackend(),
): Promise<MigrationDatabase> {
  if (isMigrationDatabase(input) || isSqlDatabase(input)) {
    return input as MigrationDatabase;
  }

  if (typeof input === 'string') {
    return openSqliteDatabase(input, runtime);
  }

  // If bun:sqlite Database or BunSqliteDatabase
  if (typeof input === 'object' && input !== null && typeof (input as any).query === 'function') {
    return wrapBunSqliteDatabase(input as BunSqliteLike);
  }

  // Accept an already-open node:sqlite DatabaseSync as well as connection strings.
  if (typeof input === 'object' && input !== null && typeof (input as any).prepare === 'function') {
    return wrapNodeSqliteDatabase(input as NodeSqliteLike);
  }

  // If SqlStorageAdapter (has protected/public run and allRows)
  if (
    typeof input === 'object' &&
    input !== null &&
    (typeof (input as any).run === 'function' || typeof (input as any).allRows === 'function')
  ) {
    return wrapSqlStorageAdapter(input as any);
  }

  throw new Error(`Invalid or unsupported database instance for migrations: ${String(input)}`);
}

function wrapSqlStorageAdapter(adapter: any): MigrationDatabase {
  const api: MigrationDatabase = {
    [MIGRATION_DB_BRAND]: true,
    run: async (sql: string, params: unknown[] = []) => {
      if (typeof adapter.run === 'function') {
        return adapter.run(sql, params);
      }
      throw new Error('Adapter does not support run(sql, params)');
    },
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      if (typeof adapter.allRows === 'function') {
        return adapter.allRows(sql, params) as Promise<T[]>;
      }
      throw new Error('Adapter does not support allRows(sql, params)');
    },
    first: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      if (typeof adapter.firstRow === 'function') {
        return adapter.firstRow(sql, params) as Promise<T | null>;
      }
      if (typeof adapter.allRows === 'function') {
        const rows = (await adapter.allRows(sql, params)) as T[];
        return rows[0] ?? null;
      }
      throw new Error('Adapter does not support firstRow(sql, params)');
    },
    exec: async (sql: string) => {
      if (typeof adapter.run === 'function') {
        await adapter.run(sql, []);
      } else {
        throw new Error('Adapter does not support exec(sql)');
      }
    },
    transaction: async <T>(fn: (db: MigrationDatabase) => Promise<T>): Promise<T> => {
      if (typeof adapter.transaction === 'function') {
        return adapter.transaction(async (txAdapter: any) => {
          const wrapped = wrapSqlStorageAdapter(txAdapter);
          return fn(wrapped);
        });
      }
      return fn(api);
    },
    close: () => {
      adapter.dispose?.();
    },
  } as any;

  return api;
}
