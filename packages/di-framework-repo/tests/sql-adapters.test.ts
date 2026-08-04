import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { D1Adapter, type D1Database } from '../src/adapters/d1';

describe('BunSqliteAdapter', () => {
  test('CRUD, filters and pagination', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 1 });
    await adapter.save({ id: 2, name: 'Bob', active: 0 });
    expect(await adapter.findById(1)).toMatchObject({ name: 'Ada' });
    expect((await adapter.findPaginated({ filter: { active: 1 }, size: 10 })).total).toBe(1);
    expect(await adapter.delete(1)).toBe(true);
    expect(await adapter.exists(1)).toBe(false);
    adapter.dispose();
  });
});

test('D1Adapter uses prepared statements and maps CRUD', async () => {
  const rows = [{ id: 1, name: 'Ada' }];
  const db: D1Database = {
    prepare() {
      return {
        bind() { return this; },
        async all<T = Record<string, unknown>>() { return { results: rows as T[] }; },
        async first<T = Record<string, unknown>>() { return rows[0] as T ?? null; },
        async run() { return { meta: { changes: 1 }, success: true }; },
      };
    },
  } as D1Database;
  const adapter = new D1Adapter<{ id: number; name: string }, number>(db, { table: 'users' });
  expect(await adapter.findById(1)).toEqual({ id: 1, name: 'Ada' });
  expect(await adapter.delete(1)).toBe(true);
});
