import type { MigrationDatabase } from './types.js';

export const MIGRATION_DB_BRAND = Symbol.for('di-framework.migration-db');

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

export async function createMigrationDatabase(
  input: unknown,
  runtime: 'bun' | 'node' = typeof (globalThis as any).Bun !== 'undefined' ? 'bun' : 'node',
): Promise<MigrationDatabase> {
  if (isMigrationDatabase(input)) {
    return input;
  }

  // If string (file path or ':memory:')
  if (typeof input === 'string') {
    if (runtime === 'bun') {
      const { Database } = await import('bun:sqlite');
      const db = new Database(input);
      return wrapBunSqliteDatabase(db);
    }
    try {
      // Node 22+ node:sqlite
      const { DatabaseSync } = await import('node:sqlite' as string);
      const db = new DatabaseSync(input);
      return wrapNodeSqliteDatabase(db);
    } catch {
      throw new Error(`Unsupported database connection string or runtime: ${input}`);
    }
  }

  // If bun:sqlite Database or BunSqliteDatabase
  if (typeof input === 'object' && input !== null && typeof (input as any).query === 'function') {
    return wrapBunSqliteDatabase(input as any);
  }

  // Accept an already-open node:sqlite DatabaseSync as well as connection strings.
  if (typeof input === 'object' && input !== null && typeof (input as any).prepare === 'function') {
    return wrapNodeSqliteDatabase(input);
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

function wrapBunSqliteDatabase(db: any): MigrationDatabase {
  let inTx = false;

  const runSql = async (sql: string, params: unknown[] = []): Promise<{ changes?: number }> => {
    if (typeof db.run === 'function') {
      const result = db.run(sql, ...params);
      return { changes: typeof result?.changes === 'number' ? result.changes : undefined };
    }
    const stmt = db.query(sql);
    const result = stmt.run(...params);
    return { changes: typeof result?.changes === 'number' ? result.changes : undefined };
  };

  const querySql = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const stmt = db.query(sql);
    return stmt.all(...params) as T[];
  };

  const firstSql = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> => {
    const stmt = db.query(sql);
    if (typeof stmt.get === 'function') {
      return (stmt.get(...params) as T | null) ?? null;
    }
    const rows = stmt.all(...params) as T[];
    return rows.length > 0 ? (rows[0] ?? null) : null;
  };

  const execSql = async (sql: string): Promise<void> => {
    if (typeof db.exec === 'function') {
      db.exec(sql);
    } else if (typeof db.run === 'function') {
      db.run(sql);
    } else {
      db.query(sql).run();
    }
  };

  const transaction = async <T>(fn: (txDb: MigrationDatabase) => Promise<T>): Promise<T> => {
    if (inTx) {
      return fn(api);
    }
    inTx = true;
    await execSql('BEGIN IMMEDIATE');
    try {
      const res = await fn(api);
      await execSql('COMMIT');
      return res;
    } catch (err) {
      try {
        await execSql('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      inTx = false;
    }
  };

  const api: MigrationDatabase = {
    [MIGRATION_DB_BRAND]: true,
    run: runSql,
    query: querySql,
    first: firstSql,
    exec: execSql,
    transaction,
    close: () => {
      db.close?.();
    },
  } as any;

  return api;
}

function wrapNodeSqliteDatabase(db: any): MigrationDatabase {
  let inTx = false;

  const runSql = async (sql: string, params: unknown[] = []): Promise<{ changes?: number }> => {
    const stmt = db.prepare(sql);
    const result = stmt.run(...params);
    return { changes: typeof result?.changes === 'number' ? result.changes : undefined };
  };

  const querySql = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const stmt = db.prepare(sql);
    return stmt.all(...params) as T[];
  };

  const firstSql = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> => {
    const stmt = db.prepare(sql);
    return (stmt.get(...params) as T | null) ?? null;
  };

  const execSql = async (sql: string): Promise<void> => {
    db.exec(sql);
  };

  const transaction = async <T>(fn: (txDb: MigrationDatabase) => Promise<T>): Promise<T> => {
    if (inTx) return fn(api);
    inTx = true;
    await execSql('BEGIN IMMEDIATE');
    try {
      const res = await fn(api);
      await execSql('COMMIT');
      return res;
    } catch (err) {
      try {
        await execSql('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      inTx = false;
    }
  };

  const api: MigrationDatabase = {
    [MIGRATION_DB_BRAND]: true,
    run: runSql,
    query: querySql,
    first: firstSql,
    exec: execSql,
    transaction,
    close: () => {
      db.close?.();
    },
  } as any;

  return api;
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
