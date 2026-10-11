import { describe, expect, test } from 'bun:test';
import * as index from '../src/index';
import type { Guard, Lease, SqlRow, SqlStatementCalls } from '../src/portable';
import * as portable from '../src/portable';

describe('helpers for out-of-tree SqlDatabase adapters', () => {
  const names = [
    'AsyncMutex',
    'SQL_DATABASE_BRAND',
    'contextLock',
    'guardedStatements',
    'leaseGuard',
    'wasmBlobBytes',
  ] as const;

  test('are exported from the portable and root entries', () => {
    for (const name of names) {
      expect(portable[name]).toBeDefined();
      expect(index[name]).toBe(portable[name]);
    }
    expect(portable.wasmBlobBytes(new Uint16Array([1]))).toBeInstanceOf(Uint8Array);
  });

  test('compose into a guarded adapter', async () => {
    const lock: Guard = portable.contextLock(new portable.AsyncMutex());
    const lease: Lease = { active: true };
    const calls: SqlStatementCalls = {
      run: async () => ({ changes: 1 }),
      query: async () => [{ n: 1 }],
      first: async () => ({ n: 1 }),
      exec: async () => {},
    };
    const db = portable.guardedStatements(portable.leaseGuard(lease, lock), calls);
    expect(await db.run('x')).toEqual({ changes: 1 });
    expect(await db.query<SqlRow>('x')).toEqual([{ n: 1 }]);
    lease.active = false;
    expect(await db.first<SqlRow>('x')).toEqual({ n: 1 });
    await db.exec('x');
  });
});
