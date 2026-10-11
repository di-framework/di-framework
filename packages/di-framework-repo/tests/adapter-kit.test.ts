import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';
import type {
  Guard,
  Lease,
  SqlDatabase,
  SqlRow,
  SqlStatementCalls,
  WasmMaybeResult,
  WasmResult,
} from '../src/adapter-kit';
import * as kit from '../src/adapter-kit';

describe('@di-framework/repo/adapter-kit', () => {
  test('exports exactly the runtime helpers adapter packages use', () => {
    expect(Object.keys(kit).sort()).toEqual([
      'AsyncMutex',
      'SQL_DATABASE_BRAND',
      'contextLock',
      'guardedStatements',
      'leaseGuard',
      'wasmBlobBytes',
    ]);
    expect(kit.SQL_DATABASE_BRAND as symbol).toBe(Symbol.for('di-framework.migration-db'));
    expect(kit.wasmBlobBytes(new Uint16Array([1]))).toBeInstanceOf(Uint8Array);
  });

  test('builds a guarded adapter from the exported pieces', async () => {
    const lock: Guard = kit.contextLock(new kit.AsyncMutex());
    const lease: Lease = { active: true };
    const calls: SqlStatementCalls = {
      run: async () => ({ changes: 1 }),
      query: async () => [{ n: 1 }],
      first: async () => ({ n: 1 }),
      exec: async () => {},
    };
    const db = kit.guardedStatements(kit.leaseGuard(lease, lock), calls);
    expect(await db.run('x')).toEqual({ changes: 1 });
    expect(await db.query<SqlRow>('x')).toEqual([{ n: 1 }]);
    lease.active = false;
    expect(await db.first<SqlRow>('x')).toEqual({ n: 1 });
    await db.exec('x');

    const ok: WasmMaybeResult<number> = { tag: 'ok', val: 1 } satisfies WasmResult<number>;
    expect(ok).toEqual({ tag: 'ok', val: 1 });
    const contract: keyof SqlDatabase = 'transaction';
    expect(contract).toBe('transaction');
  });

  test('is published as a subpath with the wasmcloud condition', () => {
    expect(pkg.exports['./adapter-kit']).toEqual({
      types: './dist/adapter-kit.d.ts',
      wasmcloud: './dist/adapter-kit.js',
      import: './dist/adapter-kit.js',
      default: './dist/adapter-kit.js',
    });
  });

  test('never references a native SQLite module', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from ['"](bun|node):sqlite['"]/);
      for (const [, spec] of source.matchAll(
        /^(?:import|export)\s+(?!type\b)[^'"]*from\s+['"](\.[^'"]+)['"]/gm,
      )) {
        visit(join(file, '..', `${spec}.ts`));
      }
    };
    visit(join(import.meta.dir, '../src/adapter-kit.ts'));
    expect(seen.size).toBeGreaterThan(1);
  });
});
