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

  test('findMany fetches several rows by id', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 1 });
    await adapter.save({ id: 2, name: 'Bob', active: 1 });
    await adapter.save({ id: 3, name: 'Cid', active: 1 });

    const rows = await adapter.findMany([1, 3]);
    expect(rows.map((r) => r.name).sort()).toEqual(['Ada', 'Cid']);
    expect(await adapter.findMany([])).toEqual([]);
  });

  test('findPaginated sorts by a single column and by an array of columns', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Bob', active: 1 });
    await adapter.save({ id: 2, name: 'Ada', active: 1 });

    const single = await adapter.findPaginated({ sort: 'name:desc' });
    expect(single.items.map((r) => r.name)).toEqual(['Bob', 'Ada']);

    const multi = await adapter.findPaginated({ sort: ['active:asc', 'name'] });
    expect(multi.items.map((r) => r.name)).toEqual(['Ada', 'Bob']);
  });

  test('transaction forwards to the callback with the adapter itself', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    const result = await adapter.transaction(async (tx) => {
      expect(tx).toBe(adapter);
      return 'done';
    });
    expect(result).toBe('done');
  });
});

test('D1Adapter uses prepared statements and maps CRUD', async () => {
  const rows = [{ id: 1, name: 'Ada' }];
  const db: D1Database = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all<T = Record<string, unknown>>() {
          return { results: rows as T[] };
        },
        async first<T = Record<string, unknown>>() {
          return (rows[0] as T) ?? null;
        },
        async run() {
          return { meta: { changes: 1 }, success: true };
        },
      };
    },
  } as D1Database;
  const adapter = new D1Adapter<{ id: number; name: string }, number>(db, { table: 'users' });
  expect(await adapter.findById(1)).toEqual({ id: 1, name: 'Ada' });
  expect(await adapter.delete(1)).toBe(true);
});

test('D1Adapter findAll uses allRows, and transaction forwards to the callback', async () => {
  const rows = [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ];
  const db: D1Database = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all<T = Record<string, unknown>>() {
          return { results: rows as T[] };
        },
        async first<T = Record<string, unknown>>() {
          return null as T | null;
        },
        async run() {
          return { meta: { changes: 0 }, success: true };
        },
      };
    },
  } as D1Database;
  const adapter = new D1Adapter<{ id: number; name: string }, number>(db, { table: 'users' });

  expect(await adapter.findAll()).toEqual(rows);

  const result = await adapter.transaction(async (tx) => {
    expect(tx).toBe(adapter);
    return 'done';
  });
  expect(result).toBe('done');
});
