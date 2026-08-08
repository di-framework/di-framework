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

  test('saveIfAbsent inserts when missing and returns false when present', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });

    expect(await adapter.saveIfAbsent({ id: 1, name: 'Ada', active: 1 })).toBe(true);
    expect(await adapter.saveIfAbsent({ id: 1, name: 'Ada Duplicate', active: 0 })).toBe(false);
    expect(await adapter.findById(1)).toMatchObject({ name: 'Ada', active: 1 });
  });

  test('compareAndSwap mutates record atomically or aborts when null returned', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 1 });

    const failed = await adapter.compareAndSwap(1, (curr) => {
      if (curr?.active !== 0) return null;
      return { ...curr, active: 0 };
    });
    expect(failed).toBe(false);

    const success = await adapter.compareAndSwap(1, (curr) => {
      if (curr?.active !== 1) return null;
      return { ...curr, active: 0 };
    });
    expect(success).toBe(true);
    expect(await adapter.findById(1)).toMatchObject({ active: 0 });
  });

  test('contention: concurrent saveIfAbsent on BunSqliteAdapter has exactly 1 winner', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });

    const promises = Array.from({ length: 20 }, (_, i) =>
      adapter.saveIfAbsent({ id: 100, name: `Name ${i}`, active: 1 }),
    );
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r === true);
    expect(winners).toHaveLength(1);
  });

  test('contention: concurrent compareAndSwap on BunSqliteAdapter has at most 1 winner per observed state', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 0 });

    const promises = Array.from({ length: 20 }, () =>
      adapter.compareAndSwap(1, (curr) => {
        if (curr?.active !== 0) return null;
        return { ...curr, active: 1 };
      }),
    );
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r === true);
    expect(winners).toHaveLength(1);
    expect(await adapter.findById(1)).toMatchObject({ active: 1 });
  });

  test('contention: concurrent transactions with async delays are properly serialized', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 0 });

    const executionOrder: string[] = [];

    const tx1 = adapter.transaction(async () => {
      executionOrder.push('tx1-start');
      await new Promise((r) => setTimeout(r, 10));
      await adapter.save({ id: 1, name: 'Ada-tx1', active: 1 });
      executionOrder.push('tx1-end');
    });

    const tx2 = adapter.transaction(async () => {
      executionOrder.push('tx2-start');
      await new Promise((r) => setTimeout(r, 10));
      await adapter.save({ id: 1, name: 'Ada-tx2', active: 2 });
      executionOrder.push('tx2-end');
    });

    await Promise.all([tx1, tx2]);

    expect(executionOrder).toEqual(['tx1-start', 'tx1-end', 'tx2-start', 'tx2-end']);
  });

  test('nested transaction on same async stack reuses open transaction', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    const result = await adapter.transaction(async (txOuter) => {
      await txOuter.save({ id: 1, name: 'Outer', active: 1 });
      return await txOuter.transaction(async (txInner) => {
        expect(txInner).toBe(adapter);
        await txInner.save({ id: 2, name: 'Inner', active: 1 });
        return 'nested-success';
      });
    });
    expect(result).toBe('nested-success');
    expect(await adapter.findById(1)).toMatchObject({ name: 'Outer' });
    expect(await adapter.findById(2)).toMatchObject({ name: 'Inner' });
  });

  test('compareAndSwap throws error when primary key is mutated', async () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)');
    const adapter = new BunSqliteAdapter<{ id: number; name: string; active: number }, number>(db, {
      table: 'users',
    });
    await adapter.save({ id: 1, name: 'Ada', active: 1 });

    await expect(
      adapter.compareAndSwap(1, (_curr) => {
        return { id: 999, name: 'Mutated Key', active: 1 } as any;
      }),
    ).rejects.toThrow('Cannot mutate entity primary key');
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

test('D1Adapter serializes concurrent transactions with async delays', async () => {
  const db: D1Database = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all<_T = Record<string, unknown>>() {
          return { results: [] };
        },
        async first<_T = Record<string, unknown>>() {
          return null;
        },
        async run() {
          return { meta: { changes: 1 }, success: true };
        },
      };
    },
  } as D1Database;
  const adapter = new D1Adapter<{ id: number; name: string }, number>(db, { table: 'users' });

  const executionOrder: string[] = [];

  const tx1 = adapter.transaction(async () => {
    executionOrder.push('d1-tx1-start');
    await new Promise((r) => setTimeout(r, 10));
    executionOrder.push('d1-tx1-end');
  });

  const tx2 = adapter.transaction(async () => {
    executionOrder.push('d1-tx2-start');
    await new Promise((r) => setTimeout(r, 10));
    executionOrder.push('d1-tx2-end');
  });

  await Promise.all([tx1, tx2]);

  expect(executionOrder).toEqual(['d1-tx1-start', 'd1-tx1-end', 'd1-tx2-start', 'd1-tx2-end']);
});

test('D1Adapter propagates BEGIN and COMMIT errors without silent swallowing', async () => {
  const dbFailure: D1Database = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<_T = Record<string, unknown>>() {
          return { results: [] };
        },
        async first<_T = Record<string, unknown>>() {
          return null;
        },
        async run() {
          if (sql === 'BEGIN IMMEDIATE') {
            throw new Error('D1 connection locked');
          }
          return { meta: { changes: 1 }, success: true };
        },
      };
    },
  } as D1Database;
  const adapter = new D1Adapter<{ id: number; name: string }, number>(dbFailure, {
    table: 'users',
  });

  let callbackExecuted = false;
  await expect(
    adapter.transaction(async () => {
      callbackExecuted = true;
    }),
  ).rejects.toThrow('D1 connection locked');

  expect(callbackExecuted).toBe(false);
});
