import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as index from '../src/index';
import type {
  SqlGuard,
  SqlLease,
  SqlRow,
  SqlStatementCalls,
  WasmMaybeResult,
  WasmResult,
} from '../src/portable';
import * as portable from '../src/portable';
import * as sqlDatabase from '../src/sqlite/sql-database';
import * as sqliteWasm from '../src/sqlite/wasm';

describe('helpers for out-of-tree SqlDatabase adapters', () => {
  const names = [
    'AsyncMutex',
    'SQL_DATABASE_BRAND',
    'contextLock',
    'guardedStatements',
    'isWasmResult',
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

  test('keep the 6.0.6 SQLite module exports', () => {
    expect(sqlDatabase.AsyncMutex).toBe(portable.AsyncMutex);
    expect(typeof sqliteWasm.unwrapWasmResult).toBe('function');
  });

  test('live in modules that do not import the SQLite adapters', () => {
    for (const file of ['sql-lock.ts', 'wasm-values.ts']) {
      const source = readFileSync(join(import.meta.dir, '../src', file), 'utf8');
      expect(source).not.toMatch(/from ['"][^'"]*sqlite/);
    }
  });

  test('recognize result records', async () => {
    const ok: WasmResult<number> = { tag: 'ok', val: 1 };
    const bare: WasmMaybeResult<number> = 1;
    expect(portable.isWasmResult(ok)).toBe(true);
    expect(portable.isWasmResult({ tag: 'err', val: 'x' })).toBe(true);
    expect(portable.isWasmResult(bare)).toBe(false);
    expect(portable.isWasmResult(null)).toBe(false);
    expect(portable.isWasmResult({ tag: 'ok' })).toBe(false);
  });

  test('compose into a guarded adapter', async () => {
    const lock: SqlGuard = portable.contextLock(new portable.AsyncMutex());
    const lease: SqlLease = { active: true };
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
