import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqlDatabase } from '@di-framework/repo';
import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorOwnershipConflictError,
  ActorRuntime,
  StaleOwnerWriteError,
  WasmSqliteActorStorage,
  type WasmSqliteDatabaseFactory,
} from '../src/index.js';
import * as portable from '../src/portable.js';

/**
 * Test double for `createWasmSqliteDatabase`: the same `SqlDatabase` shape the
 * di-framework:sqlite WIT adapter returns, backed by bun:sqlite so the SQL is real.
 */
function createFakeWasmSqlite(): {
  factory: WasmSqliteDatabaseFactory;
  opened: Array<{ path: string; raw: Database }>;
  closed: string[];
} {
  const opened: Array<{ path: string; raw: Database }> = [];
  const closed: string[] = [];

  const factory: WasmSqliteDatabaseFactory = async (filePath) => {
    const db = new Database(filePath);
    opened.push({ path: filePath, raw: db });
    const api: SqlDatabase = {
      async run(sql, params = []) {
        const res = db.prepare(sql).run(...(params as any[]));
        return { changes: Number(res.changes) };
      },
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as any[])) as T[];
      },
      async first<T>(sql: string, params: unknown[] = []) {
        return (db.prepare(sql).get(...(params as any[])) as T | null) ?? null;
      },
      async exec(sql) {
        db.exec(sql);
      },
      async transaction() {
        throw new Error('storage must not rely on SqlDatabase.transaction()');
      },
      async close() {
        closed.push(filePath);
        db.close();
      },
    };
    return api;
  };

  return { factory, opened, closed };
}

@Actor({ name: 'WasmCounter' })
class WasmCounterActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async increment(by = 1): Promise<number> {
    const next = ((await this.ctx.storage.get<number>('count')) ?? 0) + by;
    await this.ctx.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async failAfterWrite(): Promise<void> {
    await this.ctx.storage.set('count', 999);
    throw new Error('boom');
  }
}

describe('WasmSqliteActorStorage', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-actor-sqlite-'));
    cleanup.push(dir);
    return dir;
  };

  it('opens one connection per actor under baseDir with DELETE journal and FULL sync', async () => {
    const baseDir = makeTempDir();
    const fake = createFakeWasmSqlite();
    const storage = new WasmSqliteActorStorage({
      baseDir,
      fileLocking: false,
      openDatabase: fake.factory,
    });

    await Promise.all([
      storage.set('ns:Counter:a', 'x', 1),
      storage.set('ns:Counter:a', 'y', 2),
      storage.set('ns:Counter:b', 'x', 3),
    ]);

    expect(fake.opened).toHaveLength(2);
    for (const entry of fake.opened) {
      expect(entry.path.startsWith(path.resolve(baseDir))).toBe(true);
      expect(entry.path.endsWith('.db')).toBe(true);
      expect(fs.existsSync(entry.path)).toBe(true);
      expect(entry.raw.query('PRAGMA journal_mode;').get()).toEqual({ journal_mode: 'delete' });
      // synchronous: 2 === FULL
      expect(entry.raw.query('PRAGMA synchronous;').get()).toEqual({ synchronous: 2 });
    }
    expect(storage.fileLocking).toBe(false);
    expect(storage.journalMode).toBe('delete');
    expect(storage.synchronous).toBe('full');

    expect(await storage.get<number>('ns:Counter:a', 'x')).toBe(1);
    expect(await storage.get<number>('ns:Counter:b', 'x')).toBe(3);
    expect(await storage.keys('ns:Counter:a')).toEqual(['x', 'y']);
    expect(await storage.has('ns:Counter:a', 'y')).toBe(true);
    expect(await storage.delete('ns:Counter:a', 'y')).toBe(true);
    expect(await storage.delete('ns:Counter:a', 'y')).toBe(false);
    expect(await storage.entries('ns:Counter:a')).toEqual([['x', 1]]);

    await storage.closeActor('ns:Counter:a');
    expect(fake.closed).toHaveLength(1);
    await storage.close();
    expect(fake.closed).toHaveLength(2);
    await expect(storage.get('ns:Counter:a', 'x')).rejects.toThrow(/closed/);
  });

  it('persists the same schema as the native adapter and survives reopen', async () => {
    const baseDir = makeTempDir();
    const fake = createFakeWasmSqlite();
    const first = new WasmSqliteActorStorage({ baseDir, openDatabase: fake.factory });
    await first.set('Counter:k1', 'count', { n: 5 });
    await first.setIdempotencyRecord('Counter:k1', 'req-1', 'ok');
    await first.close();

    const raw = new Database(fake.opened[0]!.path, { readonly: true });
    const tables = raw
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      '_actor_idempotency',
      '_actor_identity',
      '_actor_ownership',
      '_actor_state',
    ]);
    const identity = raw.query('SELECT actor_id FROM "_actor_identity" WHERE id = 1;').get() as {
      actor_id: string;
    };
    expect(identity.actor_id).toBe('Counter:k1');
    const stateRow = raw.query('SELECT value FROM "_actor_state" WHERE key = ?;').get('count') as {
      value: string;
    };
    expect(JSON.parse(stateRow.value)).toEqual({ v: { n: 5 } });
    raw.close();

    const second = new WasmSqliteActorStorage({ baseDir, openDatabase: fake.factory });
    expect(await second.get<{ n: number }>('Counter:k1', 'count')).toEqual({ n: 5 });
    expect(await second.getIdempotencyRecord('Counter:k1', 'req-1')).toMatchObject({
      response: 'ok',
    });
    await second.close();
  });

  it('stages transaction writes and commits or rolls back atomically', async () => {
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: createFakeWasmSqlite().factory,
    });
    const id = 'Tx:1';
    await storage.set(id, 'a', 1);
    await storage.set(id, 'b', 2);

    const tx = await storage.beginTransaction(id);
    await tx.set('c', 3);
    await tx.delete('a');
    await tx.setIdempotencyRecord!('req', { ok: true });
    expect(await tx.get<number>('c')).toBe(3);
    expect(await tx.has('a')).toBe(false);
    expect((await tx.keys()).sort()).toEqual(['b', 'c']);
    // Nothing visible outside until commit
    expect(await storage.get(id, 'c')).toBeUndefined();
    expect(await storage.has(id, 'a')).toBe(true);

    await tx.commit();
    expect(await storage.dump(id)).toEqual({ b: 2, c: 3 });
    expect(await storage.getIdempotencyRecord(id, 'req')).toMatchObject({ response: { ok: true } });
    await expect(tx.get('c')).rejects.toThrow(/closed/);

    const tx2 = await storage.beginTransaction(id);
    await tx2.clear();
    await tx2.set('z', 26);
    expect(await tx2.keys()).toEqual(['z']);
    await tx2.rollback();
    expect(await storage.dump(id)).toEqual({ b: 2, c: 3 });

    const tx3 = await storage.beginTransaction(id);
    await tx3.clear();
    await tx3.set('only', true);
    await tx3.commit();
    expect(await storage.dump(id)).toEqual({ only: true });
    await storage.close();
  });

  it('fences commits with ownership generation', async () => {
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: createFakeWasmSqlite().factory,
    });
    const id = 'Owned:1';

    const own = await storage.acquireOwnership(id, 'host-a', { leaseTtlMs: 60_000 });
    expect(own).toMatchObject({ actorId: id, ownerId: 'host-a', generation: 1 });
    expect(await storage.getOwnership(id)).toMatchObject({ ownerId: 'host-a', generation: 1 });

    await expect(storage.acquireOwnership(id, 'host-b')).rejects.toBeInstanceOf(
      ActorOwnershipConflictError,
    );
    const forced = await storage.acquireOwnership(id, 'host-b', { force: true });
    expect(forced.generation).toBe(2);

    const stale = await storage.beginTransaction(id, { ownerId: 'host-a', generation: 1 });
    await stale.set('k', 'v');
    await expect(stale.commit()).rejects.toBeInstanceOf(StaleOwnerWriteError);
    expect(await storage.has(id, 'k')).toBe(false);

    const fresh = await storage.beginTransaction(id, { ownerId: 'host-b', generation: 2 });
    await fresh.set('k', 'v');
    await fresh.commit();
    expect(await storage.get<string>(id, 'k')).toBe('v');

    expect(await storage.releaseOwnership(id, 'host-a')).toBe(false);
    expect(await storage.releaseOwnership(id, 'host-b')).toBe(true);
    expect(await storage.getOwnership(id)).toBeNull();
    await storage.close();
  });

  it('drives the ActorRuntime with transactional rollback', async () => {
    const baseDir = makeTempDir();
    const storage = new WasmSqliteActorStorage({
      baseDir,
      fileLocking: false,
      openDatabase: createFakeWasmSqlite().factory,
    });
    const runtime = new ActorRuntime({ storage });
    runtime.register(WasmCounterActor);

    expect(await runtime.invoke('WasmCounter', 'c1', 'increment', [2])).toBe(2);
    expect(await runtime.invoke('WasmCounter', 'c1', 'increment', [3])).toBe(5);
    await expect(runtime.invoke('WasmCounter', 'c1', 'failAfterWrite', [])).rejects.toThrow('boom');
    expect(await runtime.invoke('WasmCounter', 'c1', 'increment', [0])).toBe(5);

    const info = await runtime.inspect('WasmCounter', 'c1', { showState: true });
    expect(info?.storagePath?.startsWith(path.resolve(baseDir))).toBe(true);
    expect(info?.state).toEqual({ count: 5 });
    await storage.close();
  });

  it('stages idempotency records and merges keys inside transactions', async () => {
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: createFakeWasmSqlite().factory,
    });
    const id = 'Idem:1';
    await storage.setIdempotencyRecord(id, 'req-outside', { ok: true });

    const tx = await storage.beginTransaction(id);
    await tx.setIdempotencyRecord!('req-tx', { from: 'tx' });
    expect(await tx.getIdempotencyRecord!('req-tx')).toMatchObject({ response: { from: 'tx' } });
    expect(await tx.getIdempotencyRecord!('req-outside')).toMatchObject({ response: { ok: true } });
    await tx.set('alpha', 1);
    await tx.set('beta', 2);
    expect((await tx.keys()).sort()).toEqual(['alpha', 'beta']);
    await tx.commit();
    expect(await storage.getIdempotencyRecord(id, 'req-tx')).toMatchObject({ response: { from: 'tx' } });
    await storage.close();
  });

  it('supports in-memory databases, lease expiry, and closed-storage guards', async () => {
    const fake = createFakeWasmSqlite();
    const storage = new WasmSqliteActorStorage({
      baseDir: ':memory:',
      inMemory: true,
      journalMode: 'memory',
      synchronous: 'normal',
      openDatabase: fake.factory,
    });
    const id = 'Mem:1';
    await storage.set(id, 'x', 1);
    expect(fake.opened.every((entry) => entry.path === ':memory:')).toBe(true);

    await storage.acquireOwnership(id, 'host-a', { leaseTtlMs: 1 });
    await Bun.sleep(5);
    const taken = await storage.acquireOwnership(id, 'host-b');
    expect(taken.ownerId).toBe('host-b');
    expect(taken.generation).toBe(2);

    await storage.close();
    await expect(storage.get(id, 'x')).rejects.toThrow(/closed/);
  });

  it('rejects undefined values and clones structured data in transactions', async () => {
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: createFakeWasmSqlite().factory,
    });
    const id = 'Clone:1';
    await expect(storage.set(id, 'bad', undefined)).rejects.toThrow(/undefined/);
    const tx = await storage.beginTransaction(id);
    await expect(tx.set('bad', undefined)).rejects.toThrow(/undefined/);
    await tx.set('obj', { nested: { n: 1 } });
    const read = await tx.get<{ nested: { n: number } }>('obj');
    read!.nested.n = 99;
    expect((await storage.get(id, 'obj'))).toBeUndefined();
    await tx.rollback();

    const tx2 = await storage.beginTransaction(id);
    await tx2.delete('missing');
    expect(await tx2.delete('missing')).toBe(false);
    await tx2.set('temp', true);
    expect(await tx2.delete('temp')).toBe(true);
    await tx2.rollback();
    await storage.close();
  });

  it('exposes transaction entries, database handles, and owner fencing edge cases', async () => {
    const fake = createFakeWasmSqlite();
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: fake.factory,
    });
    const id = 'Edge:1';
    await storage.set(id, 'a', 1);
    await storage.acquireOwnership(id, 'host-a');
    const tx = await storage.beginTransaction(id, { ownerId: 'host-a', generation: 0 });
    await tx.set('b', 2);
    expect(await tx.entries()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(tx.getDatabase?.()).toBeDefined();
    await expect(tx.commit()).rejects.toBeInstanceOf(StaleOwnerWriteError);

    await storage.acquireOwnership(id, 'host-a', { force: true });
    const badOwner = await storage.beginTransaction(id, { ownerId: 'other', generation: 1 });
    await badOwner.set('x', 1);
    await expect(badOwner.commit()).rejects.toBeInstanceOf(StaleOwnerWriteError);

    const failing = createFakeWasmSqlite();
    failing.factory = async (filePath) => {
      const api = await createFakeWasmSqlite().factory(filePath);
      const originalExec = api.exec.bind(api);
      api.exec = async (sql) => {
        if (sql.includes('COMMIT')) throw new Error('commit failed');
        return originalExec(sql);
      };
      return api;
    };
    const fragile = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: failing.factory,
    });
    const fragileTx = await fragile.beginTransaction('Fragile:1');
    await fragileTx.set('k', 'v');
    await expect(fragileTx.commit()).rejects.toThrow('commit failed');
    await fragile.close();
    await storage.close();
  });

  it('waits for in-flight opens and closes pending connections on shutdown', async () => {
    const fake = createFakeWasmSqlite();
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const delayedFactory: WasmSqliteDatabaseFactory = async (filePath) => {
      await gate;
      return fake.factory(filePath);
    };
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: delayedFactory,
    });
    const opening = storage.set('Pending:1', 'k', 'v').catch(() => undefined);
    const closing = storage.close();
    releaseOpen();
    await Promise.all([opening, closing]);
    await expect(storage.get('Pending:1', 'k')).rejects.toThrow(/closed/);
  });

  it('supports direct database access, entries, clear helpers, and closeActor', async () => {
    const storage = new WasmSqliteActorStorage({
      baseDir: makeTempDir(),
      openDatabase: createFakeWasmSqlite().factory,
    });
    const id = 'Direct:1';
    await storage.set(id, 'a', 1);
    await storage.set(id, 'b', 2);
    expect(await storage.entries<number>(id)).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(await storage.getDatabase(id)).toBeDefined();
    await storage.clear(id);
    expect(await storage.keys(id)).toEqual([]);
    await storage.set(id, 'z', 3);
    await storage.clearAll();
    expect(await storage.keys(id)).toEqual([]);
    await storage.set(id, 'only', true);
    await storage.closeActor(id);
    expect(await storage.get<boolean>(id, 'only')).toBe(true);
    await storage.close();
  });

  it('portable entry aliases SqliteActorStorage to the Wasm adapter and avoids bun:sqlite', async () => {
    expect(portable.SqliteActorStorage).toBe(WasmSqliteActorStorage);
    expect(typeof portable.ActorRuntime).toBe('function');
    expect(typeof portable.InMemoryActorStorage).toBe('function');
    expect(typeof portable.Actor).toBe('function');
    expect(typeof portable.ActorRpcDispatcher).toBe('function');

    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, '../src/portable.ts')],
      target: 'bun',
      external: ['@di-framework/repo', '@di-framework/core'],
      // Bun 1.4 BuildConfig typings omit `write`; keep the bundle in-memory.
      ...({ write: false } as object),
    });
    expect(build.success).toBe(true);
    const bundled = await Promise.all(build.outputs.map((o) => o.text()));
    expect(bundled.join('\n')).not.toContain('bun:sqlite');
  });
});
