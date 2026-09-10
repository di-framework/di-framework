import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
// The package entry registers the bun:sqlite / node:sqlite openers used for path inputs.
import { createMigrationDatabase, isMigrationDatabase } from '../src/index';

async function exercise(db: Awaited<ReturnType<typeof createMigrationDatabase>>) {
  await db.exec('CREATE TABLE t (value INTEGER)');
  expect(await db.first<{ value: number }>('SELECT * FROM t')).toBeNull();
  expect((await db.run('INSERT INTO t VALUES (?)', [1])).changes).toBe(1);
  expect(await db.query('SELECT * FROM t')).toEqual([{ value: 1 }]);
  expect(await db.first<{ value: number }>('SELECT * FROM t')).toEqual({ value: 1 });
  await db.transaction(async (tx) => {
    await tx.transaction(async (nested) => {
      await nested.run('INSERT INTO t VALUES (2)');
    });
  });
  await expect(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (3)');
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await db.query('SELECT * FROM t')).toEqual([{ value: 1 }, { value: 2 }]);
  await db.close?.();
}

test('wraps Bun and Node SQLite and preserves migration database instances', async () => {
  const db = await createMigrationDatabase(':memory:');
  expect(isMigrationDatabase(db)).toBe(true);
  expect(await createMigrationDatabase(db)).toBe(db);
  await exercise(db);
  const { DatabaseSync } = await import('node:sqlite');
  await exercise(await createMigrationDatabase(new DatabaseSync(':memory:')));
  await exercise(await createMigrationDatabase(':memory:', 'node'));
  await expect(
    createMigrationDatabase('/nonexistent-parent/invalid/db.sqlite', 'node'),
  ).rejects.toThrow('Unsupported database connection');
  await expect(createMigrationDatabase(null)).rejects.toThrow('Invalid or unsupported');
});

test('supports SQLite query-only wrappers and run-only execution fallbacks', async () => {
  const sqlite = new Database(':memory:');
  const wrapper = await createMigrationDatabase({
    query: (sql: string) => {
      const stmt = sqlite.query(sql);
      return {
        all: (...params: any[]) => stmt.all(...params),
        run: (...params: any[]) => stmt.run(...params),
      };
    },
    close: () => sqlite.close(),
  });
  await exercise(wrapper);
  const statements: string[] = [];
  const runOnly = await createMigrationDatabase({
    query: () => ({ all: () => [] }),
    run: (sql: string) => {
      statements.push(sql);
    },
  });
  await runOnly.exec('statement');
  expect(await runOnly.run('other')).toEqual({ changes: undefined });
  expect(statements).toEqual(['statement', 'other']);
});

test('adapts SQL storage methods, transaction delegates, and missing capabilities', async () => {
  const sqlite = new Database(':memory:');
  const adapter = {
    run: (sql: string, params: any[]) => sqlite.run(sql, ...params),
    allRows: (sql: string, params: any[]) => sqlite.query(sql).all(...params),
    firstRow: (sql: string, params: any[]) => sqlite.query(sql).get(...params),
    transaction: async (fn: any) => fn(adapter),
    dispose: () => sqlite.close(),
  };
  const db = await createMigrationDatabase(adapter);
  await db.exec('CREATE TABLE t (value INTEGER)');
  await db.run('INSERT INTO t VALUES (?)', [1]);
  expect(await db.query('SELECT * FROM t')).toEqual([{ value: 1 }]);
  expect(await db.first<{ value: number }>('SELECT * FROM t')).toEqual({ value: 1 });
  expect(
    await db.transaction(async (tx) => tx.first<{ value: number }>('SELECT * FROM t')),
  ).toEqual({ value: 1 });
  await db.close?.();
  const rowsOnly = await createMigrationDatabase({ allRows: () => [{ value: 2 }] });
  expect(await rowsOnly.first<{ value: number }>('select')).toEqual({ value: 2 });
  expect(await rowsOnly.transaction(async (tx) => tx.query('select'))).toEqual([{ value: 2 }]);
  await expect(rowsOnly.run('insert')).rejects.toThrow('does not support run');
  await expect(rowsOnly.exec('insert')).rejects.toThrow('does not support exec');
  await rowsOnly.close?.();
  const runOnly = await createMigrationDatabase({ run: () => ({ changes: 0 }) });
  await expect(runOnly.query('select')).rejects.toThrow('does not support allRows');
  await expect(runOnly.first('select')).rejects.toThrow('does not support firstRow');
  const emptyRows = await createMigrationDatabase({ allRows: () => [] });
  expect(await emptyRows.first('select')).toBeNull();
});
