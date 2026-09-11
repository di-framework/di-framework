import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  AsyncMutex,
  createMigrationDatabase,
  createSqlDatabase,
  createSqlDatabaseFromWasmConnection,
  createWasmSqliteDatabase,
  detectSqliteBackend,
  fromWasmSqlRow,
  fromWasmSqlValue,
  getSqliteOpener,
  isMigrationDatabase,
  isSqlDatabase,
  isWasmSqliteBackendRequested,
  openSqliteDatabase,
  registeredSqliteBackends,
  registerSqliteOpener,
  requestedSqliteBackend,
  type SqlDatabase,
  toWasmSqlParams,
  toWasmSqlValue,
  unwrapWasmResult,
  type WasmSqliteConnection,
  WasmSqliteError,
  type WasmSqliteModule,
  type WasmSqliteOpenOptions,
  type WasmSqlRow,
  type WasmSqlValue,
  wasmSqliteJournalModeSql,
  wasmSqlitePragmas,
  wasmSqliteSyncModeSql,
  wrapBunSqliteDatabase,
} from '../src/index';

describe('sql-value conversion', () => {
  test('encodes JavaScript parameters as sql-value variants', () => {
    expect(toWasmSqlValue(null)).toEqual({ tag: 'null' });
    expect(toWasmSqlValue(undefined)).toEqual({ tag: 'null' });
    expect(toWasmSqlValue(42)).toEqual({ tag: 'integer', val: 42 });
    expect(toWasmSqlValue(-7)).toEqual({ tag: 'integer', val: -7 });
    expect(toWasmSqlValue(1.5)).toEqual({ tag: 'real', val: 1.5 });
    expect(toWasmSqlValue(Number.MAX_SAFE_INTEGER + 2)).toEqual({
      tag: 'real',
      val: Number.MAX_SAFE_INTEGER + 2,
    });
    // componentize-qjs lowers WIT s64 from JS numbers; oversized bigints are rejected.
    expect(() => toWasmSqlValue(2n ** 62n)).toThrow(/MAX_SAFE_INTEGER/);
    expect(toWasmSqlValue(42n)).toEqual({ tag: 'integer', val: 42 });
    expect(toWasmSqlValue(true)).toEqual({ tag: 'integer', val: 1 });
    expect(toWasmSqlValue(false)).toEqual({ tag: 'integer', val: 0 });
    expect(toWasmSqlValue('text')).toEqual({ tag: 'text', val: 'text' });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toWasmSqlValue(bytes)).toEqual({ tag: 'blob', val: bytes });
    expect(toWasmSqlValue(bytes.buffer)).toEqual({ tag: 'blob', val: bytes });
    const view = new Uint16Array([258]);
    expect(toWasmSqlValue(view)).toEqual({
      tag: 'blob',
      val: new Uint8Array(view.buffer, 0, 2),
    });
    const date = new Date('2026-09-09T12:00:00.000Z');
    expect(toWasmSqlValue(date)).toEqual({ tag: 'text', val: '2026-09-09T12:00:00.000Z' });
    expect(() => toWasmSqlValue({ nested: true })).toThrow(TypeError);
    expect(() => toWasmSqlValue(Symbol('x'))).toThrow(/symbol/);
    expect(toWasmSqlParams([1, 'a', null])).toEqual([
      { tag: 'integer', val: 1 },
      { tag: 'text', val: 'a' },
      { tag: 'null' },
    ]);
  });

  test('decodes sql-value variants into native driver values', () => {
    expect(fromWasmSqlValue({ tag: 'null' })).toBeNull();
    expect(fromWasmSqlValue({ tag: 'integer', val: 42n })).toBe(42);
    expect(fromWasmSqlValue({ tag: 'integer', val: 7 })).toBe(7);
    expect(fromWasmSqlValue({ tag: 'integer', val: 2n ** 62n })).toBe(2n ** 62n);
    expect(fromWasmSqlValue({ tag: 'real', val: 2.5 })).toBe(2.5);
    expect(fromWasmSqlValue({ tag: 'text', val: 'hi' })).toBe('hi');
    const bytes = new Uint8Array([9]);
    expect(fromWasmSqlValue({ tag: 'blob', val: bytes })).toBe(bytes);
    expect(fromWasmSqlValue({ tag: 'blob', val: [1, 2] })).toEqual(new Uint8Array([1, 2]));
    expect(() => fromWasmSqlValue({ tag: 'weird' } as unknown as WasmSqlValue)).toThrow(
      WasmSqliteError,
    );
    expect(
      fromWasmSqlRow([
        ['id', { tag: 'integer', val: 1n }],
        ['name', { tag: 'text', val: 'a' }],
        ['score', { tag: 'null' }],
      ]),
    ).toEqual({ id: 1, name: 'a', score: null });
  });

  test('unwraps result records and normalizes error payloads', () => {
    expect(unwrapWasmResult({ tag: 'ok', val: 3 })).toBe(3);
    expect(unwrapWasmResult(5)).toBe(5);
    expect(() =>
      unwrapWasmResult({ tag: 'err', val: { tag: 'invalid-sql', val: 'near "SELEC"' } }),
    ).toThrow('SQLite invalid-sql: near "SELEC"');
    try {
      unwrapWasmResult({
        tag: 'err',
        val: { tag: 'execution-failed', val: { code: 19, extendedCode: 2067, message: 'UNIQUE' } },
      });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(WasmSqliteError);
      const sqliteError = error as WasmSqliteError;
      expect(sqliteError.tag).toBe('execution-failed');
      expect(sqliteError.code).toBe(19);
      expect(sqliteError.extendedCode).toBe(2067);
      expect(sqliteError.message).toBe('SQLite execution-failed: UNIQUE');
    }
    expect(wasmSqlitePragmas()).toEqual([
      'PRAGMA journal_mode = DELETE;',
      'PRAGMA synchronous = FULL;',
    ]);
    expect(
      wasmSqlitePragmas({
        journalMode: 'memory',
        synchronous: 'off',
        busyTimeoutMs: 10,
        foreignKeys: true,
      }),
    ).toEqual([
      'PRAGMA journal_mode = MEMORY;',
      'PRAGMA synchronous = OFF;',
      'PRAGMA busy_timeout = 10;',
      'PRAGMA foreign_keys = ON;',
    ]);
    expect(wasmSqlitePragmas({ foreignKeys: false })).toEqual([
      'PRAGMA journal_mode = DELETE;',
      'PRAGMA synchronous = FULL;',
      'PRAGMA foreign_keys = OFF;',
    ]);
    expect(wasmSqliteJournalModeSql()).toBe('DELETE');
    expect(wasmSqliteJournalModeSql('PERSIST')).toBe('PERSIST');
    expect(wasmSqliteSyncModeSql()).toBe('FULL');
    expect(wasmSqliteSyncModeSql('Normal')).toBe('NORMAL');
    expect(() => wasmSqliteJournalModeSql('delete; DROP TABLE t')).toThrow(/journalMode/);
    expect(() => wasmSqliteJournalModeSql(1)).toThrow(/journalMode/);
    expect(() => wasmSqliteSyncModeSql('full; SELECT 1')).toThrow(/synchronous/);
    expect(() =>
      wasmSqlitePragmas({ journalMode: 'wal' as WasmSqliteOpenOptions['journalMode'] }),
    ).toThrow(/journalMode/);
    expect(() =>
      wasmSqlitePragmas({ synchronous: 'extra' as WasmSqliteOpenOptions['synchronous'] }),
    ).toThrow(/synchronous/);
  });
});

/**
 * Mock of the WIT `connection` resource on top of bun:sqlite so SQL semantics
 * are real. `resultRecords` toggles between hosts that return
 * `{ tag: 'ok' | 'err' }` records and hosts that throw errors with `payload`.
 */
function mockWasmSqlite(resultRecords: boolean) {
  const log: string[] = [];
  const opened: Array<{ path: string; options: WasmSqliteOpenOptions | undefined }> = [];
  const encodeParams = (params: WasmSqlValue[]) =>
    params.map((param) => {
      switch (param.tag) {
        case 'null':
          return null;
        case 'integer':
          return typeof param.val === 'bigint' ? Number(param.val) : param.val;
        default:
          return param.val;
      }
    });
  const encodeValue = (value: unknown): WasmSqlValue => {
    if (value === null || value === undefined) return { tag: 'null' };
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { tag: 'integer', val: BigInt(value) }
        : { tag: 'real', val: value };
    }
    if (typeof value === 'bigint') return { tag: 'integer', val: value };
    if (typeof value === 'string') return { tag: 'text', val: value };
    if (value instanceof Uint8Array) return { tag: 'blob', val: value };
    throw new Error(`unexpected ${typeof value}`);
  };
  const encodeRow = (row: Record<string, unknown>): WasmSqlRow =>
    Object.entries(row).map(([column, value]) => [column, encodeValue(value)]);
  const wrap = <T>(fn: () => T): T | { tag: 'ok'; val: T } | { tag: 'err'; val: unknown } => {
    try {
      const value = fn();
      return resultRecords ? { tag: 'ok', val: value } : value;
    } catch (error) {
      const payload = { tag: 'execution-failed', val: (error as Error).message };
      if (resultRecords) return { tag: 'err', val: payload };
      throw Object.assign(new Error('ComponentError'), { payload });
    }
  };

  const module: WasmSqliteModule = {
    open(path, options) {
      opened.push({ path, options });
      return wrap(() => {
        if (path === '/definitely/missing/dir/x.db') throw new Error('unable to open database');
        const db = new Database(path);
        const connection: WasmSqliteConnection = {
          run: (sql, params) =>
            wrap(() => {
              log.push(sql);
              return BigInt(db.prepare(sql).run(...(encodeParams(params) as any[])).changes);
            }),
          query: (sql, params) =>
            wrap(() => {
              log.push(sql);
              return (db.prepare(sql).all(...(encodeParams(params) as any[])) as any[]).map(
                encodeRow,
              );
            }),
          first: (sql, params) =>
            wrap(() => {
              log.push(sql);
              const row = db.prepare(sql).get(...(encodeParams(params) as any[])) as any;
              return row ? encodeRow(row) : undefined;
            }),
          exec: (sql) =>
            wrap(() => {
              log.push(sql);
              db.exec(sql);
            }),
          close: () =>
            wrap(() => {
              log.push('<close>');
              db.close();
            }),
        };
        return connection;
      });
    },
  };
  return { module, log, opened };
}

async function exerciseSqlDatabase(db: SqlDatabase) {
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB)');
  expect(await db.first('SELECT * FROM t')).toBeNull();
  expect(
    (
      await db.run('INSERT INTO t (id, name, score, data) VALUES (?, ?, ?, ?)', [
        1,
        'alice',
        1.5,
        new Uint8Array([1, 2]),
      ])
    ).changes,
  ).toBe(1);
  expect(await db.query('SELECT * FROM t')).toEqual([
    { id: 1, name: 'alice', score: 1.5, data: new Uint8Array([1, 2]) },
  ]);
  expect(await db.first<{ name: string }>('SELECT name FROM t WHERE id = ?', [1])).toEqual({
    name: 'alice',
  });

  // Nested transactions join the outer one; failures roll everything back.
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO t (id, name) VALUES (2, ?)', ['bob']);
    await tx.transaction(async (nested) => {
      await nested.run('INSERT INTO t (id, name) VALUES (3, ?)', ['carol']);
    });
  });
  await expect(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id, name) VALUES (4, ?)', ['dave']);
      throw new Error('rollback please');
    }),
  ).rejects.toThrow('rollback please');
  expect((await db.query<{ id: number }>('SELECT id FROM t ORDER BY id')).map((r) => r.id)).toEqual(
    [1, 2, 3],
  );

  // Concurrent transactions are serialized, not interleaved.
  const order: string[] = [];
  await Promise.all([
    db.transaction(async (tx) => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.run('INSERT INTO t (id, name) VALUES (10, ?)', ['a']);
      order.push('a:end');
    }),
    db.transaction(async (tx) => {
      order.push('b:start');
      await tx.run('INSERT INTO t (id, name) VALUES (11, ?)', ['b']);
      order.push('b:end');
    }),
  ]);
  expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

  // Concurrent outer statements wait for an open transaction; they must not
  // join it (or they would roll back with it).
  let releaseOuter!: () => void;
  const holdOuter = new Promise<void>((resolve) => {
    releaseOuter = resolve;
  });
  const innerTx = db.transaction(async (tx) => {
    await tx.run('INSERT INTO t (id, name) VALUES (20, ?)', ['inside']);
    await holdOuter;
    throw new Error('drop inner');
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outerInsert = db.run('INSERT INTO t (id, name) VALUES (21, ?)', ['outside']);
  releaseOuter();
  await expect(innerTx).rejects.toThrow('drop inner');
  await outerInsert;
  expect(
    (await db.query<{ id: number }>('SELECT id FROM t ORDER BY id')).map((row) => row.id),
  ).toEqual([1, 2, 3, 10, 11, 21]);

  await expect(db.run('INSERT INTO t (id) VALUES (1)')).rejects.toThrow(/UNIQUE|constraint/i);
  await expect(db.exec('SELEC nonsense')).rejects.toThrow();
}

describe('Wasm SQLite adapter', () => {
  for (const resultRecords of [true, false]) {
    test(`adapts a WIT connection (${resultRecords ? 'result records' : 'thrown payloads'})`, async () => {
      const { module, log, opened } = mockWasmSqlite(resultRecords);
      const db = await createWasmSqliteDatabase(':memory:', { module });
      expect(isSqlDatabase(db)).toBe(true);
      expect(isMigrationDatabase(db)).toBe(true);
      expect(opened).toEqual([
        {
          path: ':memory:',
          options: { create: true, readOnly: false, synchronous: 'full', journalMode: 'delete' },
        },
      ]);
      expect(log.slice(0, 2)).toEqual([
        'PRAGMA journal_mode = DELETE;',
        'PRAGMA synchronous = FULL;',
      ]);
      await exerciseSqlDatabase(db);
      expect(log.filter((sql) => sql === 'BEGIN IMMEDIATE')).toHaveLength(5);
      expect(log.filter((sql) => sql === 'COMMIT')).toHaveLength(3);
      expect(log.filter((sql) => sql === 'ROLLBACK')).toHaveLength(2);
      await db.close?.();
      expect(log.at(-1)).toBe('<close>');
    });
  }

  test('surfaces errors as WasmSqliteError with the WIT tag', async () => {
    const { module } = mockWasmSqlite(true);
    const db = await createWasmSqliteDatabase(':memory:', { module });
    let caught: unknown;
    try {
      await db.exec('CREATE TABLE');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WasmSqliteError);
    expect((caught as WasmSqliteError).tag).toBe('execution-failed');
    await expect(
      createWasmSqliteDatabase('/definitely/missing/dir/x.db', { module }),
    ).rejects.toThrow('SQLite execution-failed: unable to open database');
  });

  test('forwards open options, custom loaders, and skips pragmas when asked', async () => {
    const { module, log, opened } = mockWasmSqlite(false);
    const db = await createWasmSqliteDatabase(':memory:', {
      loadModule: async () => module,
      journalMode: 'memory',
      synchronous: 'normal',
      busyTimeoutMs: 250,
      foreignKeys: true,
      readOnly: false,
      create: false,
    });
    expect(opened[0]?.options).toEqual({
      create: false,
      readOnly: false,
      synchronous: 'normal',
      journalMode: 'memory',
      busyTimeoutMs: 250,
      foreignKeys: true,
    });
    expect(log).toEqual([
      'PRAGMA journal_mode = MEMORY;',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA busy_timeout = 250;',
      'PRAGMA foreign_keys = ON;',
    ]);
    await db.close?.();

    await expect(
      createWasmSqliteDatabase(':memory:', {
        module,
        journalMode: 'delete; ATTACH' as WasmSqliteOpenOptions['journalMode'],
      }),
    ).rejects.toThrow(/journalMode/);
    await expect(
      createWasmSqliteDatabase(':memory:', {
        module,
        synchronous: 'full; ATTACH' as WasmSqliteOpenOptions['synchronous'],
      }),
    ).rejects.toThrow(/synchronous/);
    expect(opened).toHaveLength(1);

    const quiet = mockWasmSqlite(false);
    const silent = await createWasmSqliteDatabase(':memory:', {
      module: quiet.module,
      applyPragmas: false,
    });
    expect(quiet.log).toEqual([]);
    await silent.close?.();
  });

  test('closes the connection when pragmas fail and rejects when the import is missing', async () => {
    const closed: string[] = [];
    const failing: WasmSqliteModule = {
      open: () => ({
        run: () => 0n,
        query: () => [],
        first: () => undefined,
        exec: () => {
          throw { tag: 'other', val: 'pragma refused' };
        },
        close: () => {
          closed.push('closed');
        },
      }),
    };
    await expect(createWasmSqliteDatabase(':memory:', { module: failing })).rejects.toThrow(
      'SQLite other: pragma refused',
    );
    expect(closed).toEqual(['closed']);
    await expect(createWasmSqliteDatabase(':memory:')).rejects.toThrow(
      /di-framework:sqlite\/database@0\.1\.0 import is unavailable/,
    );
  });

  test('createSqlDatabaseFromWasmConnection accepts async host methods', async () => {
    const rows: WasmSqlRow[] = [[['value', { tag: 'integer', val: 5n }]]];
    const connection: WasmSqliteConnection = {
      run: async () => 2,
      query: async () => rows,
      first: async () => ({ tag: 'ok', val: rows[0] }),
      exec: async () => undefined,
      close: async () => ({ tag: 'ok', val: undefined }),
    };
    const db = createSqlDatabaseFromWasmConnection(connection);
    expect(await db.run('x')).toEqual({ changes: 2 });
    expect(await db.query('x')).toEqual([{ value: 5 }]);
    expect(await db.first<{ value: number }>('x')).toEqual({ value: 5 });
    await db.exec('x');
    await db.close?.();
  });
});

describe('SqlDatabase wrappers and backend registry', () => {
  test('Bun wrapper shares transaction semantics with the Wasm adapter', async () => {
    const db = wrapBunSqliteDatabase(new Database(':memory:'));
    await exerciseSqlDatabase(db);
    await db.close?.();
  });

  test('createSqlDatabase falls back to query() for drivers without first()', async () => {
    const seen: string[] = [];
    const db = createSqlDatabase({
      run: () => ({ changes: 1n as unknown as number }),
      query: (sql) => {
        seen.push(sql);
        return [{ a: 1 }, { a: 2 }];
      },
      exec: () => {},
    });
    expect(await db.run('x')).toEqual({ changes: 1 });
    expect(await db.first<{ a: number }>('SELECT a')).toEqual({ a: 1 });
    expect(seen).toEqual(['SELECT a']);
    await db.close?.();
  });

  test('AsyncMutex releases on failure and preserves order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    await expect(
      mutex.run(async () => {
        order.push(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await Promise.all([
      mutex.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(2);
      }),
      mutex.run(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('detects node without Bun and reports empty opener maps', async () => {
    expect(
      detectSqliteBackend({ bunGlobal: undefined, hasOpener: (backend) => backend === 'node' }),
    ).toBe('node');
    expect(detectSqliteBackend({ bunGlobal: undefined, hasOpener: () => false })).toBe('wasm');
    await expect(
      openSqliteDatabase(':memory:', 'wasm', { getOpener: () => undefined }),
    ).rejects.toThrow(/No SQLite backend is registered/);
  });

  test('reads requested sqlite backend env vars and falls back across openers', async () => {
    const previous = process.env.DI_SQLITE_BACKEND;
    process.env.DI_SQLITE_BACKEND = ' wasm ';
    try {
      expect(requestedSqliteBackend()).toBe('wasm');
      expect(isWasmSqliteBackendRequested()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DI_SQLITE_BACKEND;
      else process.env.DI_SQLITE_BACKEND = previous;
    }

    registerSqliteOpener('wasm', async () => {
      throw new Error('wasm unavailable');
    });
    await expect(openSqliteDatabase(':memory:', 'wasm')).rejects.toThrow(
      /Unsupported database connection string or runtime: :memory: \(wasm unavailable\)/,
    );
  });

  test('registers bun, node, and wasm openers and honours DI_SQLITE_BACKEND', async () => {
    expect(registeredSqliteBackends().sort()).toEqual(['bun', 'node', 'wasm']);
    expect(getSqliteOpener('wasm')).toBeDefined();
    expect(detectSqliteBackend()).toBe('bun');
    const previous = process.env.DI_SQLITE_BACKEND;
    process.env.DI_SQLITE_BACKEND = 'wasm';
    try {
      expect(detectSqliteBackend()).toBe('wasm');
      // Without a composed host the Wasm import is missing and there is no fallback.
      await expect(createMigrationDatabase(':memory:')).rejects.toThrow(
        /Unsupported database connection string or runtime: :memory:/,
      );
    } finally {
      if (previous === undefined) delete process.env.DI_SQLITE_BACKEND;
      else process.env.DI_SQLITE_BACKEND = previous;
    }
    const bun = await openSqliteDatabase(':memory:', 'bun');
    expect(await bun.first<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
    await bun.close?.();
    // Explicit wasm without a host reports the failure instead of silently using Bun.
    await expect(openSqliteDatabase(':memory:', 'wasm')).rejects.toThrow(
      /Unsupported database connection string or runtime/,
    );
  });

  test('createMigrationDatabase returns SqlDatabase instances unchanged', async () => {
    const { module } = mockWasmSqlite(true);
    const db = await createWasmSqliteDatabase(':memory:', { module });
    expect(await createMigrationDatabase(db)).toBe(db);
    await db.close?.();
  });
});
