import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';

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
