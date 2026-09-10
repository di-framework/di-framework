/**
 * Wasm-safe SQLite storage adapter for @di-framework/actors.
 *
 * Mirrors the schema and semantics of the native SqliteActorStorage (state table,
 * idempotency records, ownership fencing, single-writer transactions) but talks to
 * SQLite through the composed `di-framework:sqlite` component via
 * `createWasmSqliteDatabase` from @di-framework/repo. It has no `bun:sqlite`
 * dependency and never uses file locks: a WASI guest is single-threaded and
 * exclusive ownership is enforced by the deployment (replicas: 1).
 *
 * One connection is opened lazily per actor database file under `baseDir` and kept
 * open until `closeActor()` / `close()` is called.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqlDatabase } from '@di-framework/repo';
import { createWasmSqliteDatabase } from '@di-framework/repo';
import { ActorOwnershipConflictError, StaleOwnerWriteError } from '../distributed/errors.js';
import type { ActorOwnershipRecord } from '../distributed/types.js';
import { actorIdentityToPath } from './path.js';
import type { ActorStorage, ActorStorageTransaction, TransactionOptions } from './types.js';

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' && typeof value !== 'function') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function serializeValue(value: unknown): string {
  if (value === undefined)
    throw new TypeError('Actor storage does not support undefined values; use delete() instead');
  return JSON.stringify({ v: value });
}

function deserializeValue<T>(raw: string): T {
  const parsed = JSON.parse(raw);
  return parsed.v as T;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS "_actor_state" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "_actor_ownership" (
    "id" INTEGER PRIMARY KEY CHECK (id = 1),
    "owner_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "acquired_at" INTEGER NOT NULL,
    "lease_expires_at" INTEGER
  );
  CREATE TABLE IF NOT EXISTS "_actor_idempotency" (
    "request_id" TEXT PRIMARY KEY,
    "response" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "_actor_identity" (
    "id" INTEGER PRIMARY KEY CHECK (id = 1),
    "actor_id" TEXT NOT NULL
  );
`;

const UPSERT_STATE_SQL =
  'INSERT INTO "_actor_state" ("key", "value", "updated_at") VALUES (?, ?, ?) ' +
  'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at";';

const UPSERT_IDEMPOTENCY_SQL =
  'INSERT INTO "_actor_idempotency" ("request_id", "response", "created_at") VALUES (?, ?, ?) ' +
  'ON CONFLICT("request_id") DO UPDATE SET "response" = excluded."response", "created_at" = excluded."created_at";';

const SELECT_OWNERSHIP_SQL =
  'SELECT owner_id, generation, acquired_at, lease_expires_at FROM "_actor_ownership" WHERE id = 1;';

interface OwnershipRow {
  owner_id: string;
  generation: number;
  acquired_at: number;
  lease_expires_at: number | null;
}

/**
 * Opens (or creates) the database file at `path` and returns a SqlDatabase handle.
 * Matches the shape of `createWasmSqliteDatabase(path)` / `SqliteOpener` from @di-framework/repo.
 */
export type WasmSqliteDatabaseFactory = (path: string) => Promise<SqlDatabase>;

export interface WasmSqliteActorStorageOptions {
  /**
   * Base directory where actor SQLite databases are stored.
   * Defaults to '.actors'.
   */
  baseDir?: string;

  /**
   * Open every actor database as a private in-memory database (':memory:').
   * Data lives as long as the actor connection stays open.
   */
  inMemory?: boolean;

  /**
   * Journal mode applied after opening each actor database. WASI file systems do
   * not provide the shared memory WAL needs, so this defaults to 'delete'.
   */
  journalMode?: 'delete' | 'persist' | 'memory' | 'truncate';

  /**
   * Synchronous mode applied after opening each actor database. Defaults to 'full'.
   */
  synchronous?: 'full' | 'normal' | 'off';

  /**
   * Accepted for drop-in compatibility with SqliteActorStorageOptions.
   * File locking is never used by the Wasm adapter; a value of `true` is ignored.
   */
  fileLocking?: boolean;

  /**
   * Accepted for drop-in compatibility with SqliteActorStorageOptions. Ignored.
   */
  lockTimeoutMs?: number;

  /**
   * Accepted for drop-in compatibility with SqliteActorStorageOptions. Ignored;
   * connections are kept open until closeActor()/close().
   */
  maxConnections?: number;

  /**
   * Accepted for drop-in compatibility with SqliteActorStorageOptions. Ignored.
   */
  idleTimeoutMs?: number;

  /**
   * Factory used to open a database file. Defaults to `createWasmSqliteDatabase` from
   * @di-framework/repo. Primarily useful for tests and alternative SqlDatabase hosts.
   */
  openDatabase?: WasmSqliteDatabaseFactory;
}

interface ActorConnection {
  actorId: string;
  filePath: string;
  db: SqlDatabase;
  activeTransactions: number;
}

/**
 * Isolated transaction for the Wasm SQLite actor storage.
 * Reads see staged writes; nothing touches the database until commit().
 */
export class WasmSqliteActorStorageTransaction implements ActorStorageTransaction {
  private readonly actorId: string;
  private readonly storage: WasmSqliteActorStorage;
  private readonly db: SqlDatabase;
  private readonly ownerId?: string;
  private readonly generation?: number;
  private readonly stagedSets = new Map<string, any>();
  private readonly stagedDeletes = new Set<string>();
  private stagedIdempotency?: { requestId: string; response: unknown };
  private clearAllStaged = false;
  private closed = false;

  constructor(
    actorId: string,
    storage: WasmSqliteActorStorage,
    db: SqlDatabase,
    options?: TransactionOptions,
  ) {
    this.actorId = actorId;
    this.storage = storage;
    this.db = db;
    this.ownerId = options?.ownerId;
    this.generation = options?.generation;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Transaction has already been closed (committed or rolled back).');
    }
  }

  async setIdempotencyRecord(requestId: string, response: unknown): Promise<void> {
    this.assertOpen();
    this.stagedIdempotency = { requestId, response };
  }

  async getIdempotencyRecord(
    requestId: string,
  ): Promise<{ response: unknown; createdAt: number } | undefined> {
    this.assertOpen();
    if (this.stagedIdempotency && this.stagedIdempotency.requestId === requestId) {
      return { response: this.stagedIdempotency.response, createdAt: Date.now() };
    }
    return await this.storage.getIdempotencyRecord(this.actorId, requestId);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    this.assertOpen();
    if (this.stagedDeletes.has(key)) return undefined;
    if (this.stagedSets.has(key)) return cloneValue(this.stagedSets.get(key) as T);
    if (this.clearAllStaged) return undefined;
    const committed = await this.storage.get<T>(this.actorId, key);
    return cloneValue(committed);
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.assertOpen();
    if (value === undefined)
      throw new TypeError('Actor storage does not support undefined values; use delete() instead');
    this.stagedDeletes.delete(key);
    this.stagedSets.set(key, cloneValue(value));
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    const hadStaged = this.stagedSets.has(key);
    this.stagedSets.delete(key);
    this.stagedDeletes.add(key);

    if (hadStaged) return true;
    if (this.clearAllStaged) return false;
    return await this.storage.has(this.actorId, key);
  }

  async has(key: string): Promise<boolean> {
    this.assertOpen();
    if (this.stagedDeletes.has(key)) return false;
    if (this.stagedSets.has(key)) return true;
    if (this.clearAllStaged) return false;
    return await this.storage.has(this.actorId, key);
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    const keySet = new Set<string>();
    if (!this.clearAllStaged) {
      const committedKeys = await this.storage.keys(this.actorId);
      for (const k of committedKeys) {
        if (!this.stagedDeletes.has(k)) keySet.add(k);
      }
    }
    for (const k of this.stagedSets.keys()) keySet.add(k);
    return Array.from(keySet);
  }

  async entries<T = unknown>(): Promise<[string, T][]> {
    this.assertOpen();
    const allKeys = await this.keys();
    const result: [string, T][] = [];
    for (const key of allKeys) {
      const val = await this.get<T>(key);
      if (val !== undefined) result.push([key, val]);
    }
    return result;
  }

  async clear(): Promise<void> {
    this.assertOpen();
    this.stagedSets.clear();
    this.stagedDeletes.clear();
    this.clearAllStaged = true;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    const db = this.db;

    await db.exec('BEGIN IMMEDIATE;');
    try {
      // Storage fencing: authoritative storage checks the ownership generation on every commit.
      if (this.generation !== undefined) {
        const row = await db.first<OwnershipRow>(SELECT_OWNERSHIP_SQL);
        if (
          row &&
          (Number(row.generation) > this.generation ||
            (this.ownerId && row.owner_id !== this.ownerId))
        ) {
          throw new StaleOwnerWriteError(
            this.actorId,
            this.generation,
            Number(row.generation),
            row.owner_id,
          );
        }
      }

      if (this.clearAllStaged) {
        await db.run('DELETE FROM "_actor_state";');
      }
      for (const key of this.stagedDeletes) {
        await db.run('DELETE FROM "_actor_state" WHERE "key" = ?;', [key]);
      }
      if (this.stagedSets.size > 0) {
        const now = Date.now();
        for (const [key, value] of this.stagedSets.entries()) {
          await db.run(UPSERT_STATE_SQL, [key, serializeValue(value), now]);
        }
      }
      if (this.stagedIdempotency) {
        await db.run(UPSERT_IDEMPOTENCY_SQL, [
          this.stagedIdempotency.requestId,
          serializeValue(this.stagedIdempotency.response),
          Date.now(),
        ]);
      }
      await db.exec('COMMIT;');
    } catch (err) {
      try {
        await db.exec('ROLLBACK;');
      } catch {}
      throw err;
    } finally {
      this.closed = true;
      this.storage._decrementActiveTransactions(this.actorId);
    }
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.stagedSets.clear();
    this.stagedDeletes.clear();
    this.clearAllStaged = false;
    this.closed = true;
    this.storage._decrementActiveTransactions(this.actorId);
  }

  getDatabase(): SqlDatabase {
    return this.db;
  }
}

/**
 * Wasm SQLite Actor Storage Provider.
 */
export class WasmSqliteActorStorage implements ActorStorage {
  readonly baseDir: string;
  readonly inMemory: boolean;
  readonly journalMode: 'delete' | 'persist' | 'memory' | 'truncate';
  readonly synchronous: 'full' | 'normal' | 'off';
  /** Always false: the Wasm adapter never takes file locks. */
  readonly fileLocking = false as const;

  private readonly openDatabase: WasmSqliteDatabaseFactory;
  private readonly connections = new Map<string, ActorConnection>();
  private readonly pending = new Map<string, Promise<ActorConnection>>();
  private closed = false;

  constructor(options: WasmSqliteActorStorageOptions = {}) {
    this.inMemory = options.inMemory === true || options.baseDir === ':memory:';
    this.baseDir = options.baseDir ?? (this.inMemory ? ':memory:' : '.actors');
    this.journalMode = options.journalMode ?? 'delete';
    this.synchronous = options.synchronous ?? 'full';
    this.openDatabase = options.openDatabase ?? ((filePath) => createWasmSqliteDatabase(filePath));
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error('WasmSqliteActorStorage has already been closed.');
    }
  }

  /**
   * Lazily opens (once) and caches the database connection for an actor.
   */
  async getConnection(actorId: string): Promise<ActorConnection> {
    this.assertNotClosed();

    const existing = this.connections.get(actorId);
    if (existing) return existing;

    const inflight = this.pending.get(actorId);
    if (inflight) return inflight;

    const opening = this.openConnection(actorId).finally(() => {
      this.pending.delete(actorId);
    });
    this.pending.set(actorId, opening);
    return opening;
  }

  private async openConnection(actorId: string): Promise<ActorConnection> {
    const filePath = actorIdentityToPath(actorId, {
      baseDir: this.baseDir,
      inMemory: this.inMemory,
    });

    if (!this.inMemory) {
      // Best effort: the sqlite provider is expected to create parent directories
      // itself on WASI hosts, but create them when a real filesystem is available.
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {}
    }

    const db = await this.openDatabase(this.inMemory ? ':memory:' : filePath);

    try {
      // Durable single-writer settings for WASI: rollback journal + fsync on every commit.
      await db.exec(`PRAGMA journal_mode = ${this.journalMode.toUpperCase()};`);
      await db.exec(`PRAGMA synchronous = ${this.synchronous.toUpperCase()};`);
      await db.exec(SCHEMA_SQL);
      await db.run('INSERT OR IGNORE INTO "_actor_identity" ("id", "actor_id") VALUES (1, ?);', [
        actorId,
      ]);
    } catch (err) {
      try {
        await db.close?.();
      } catch {}
      throw err;
    }

    if (this.closed) {
      try {
        await db.close?.();
      } catch {}
      throw new Error('WasmSqliteActorStorage has already been closed.');
    }

    const conn: ActorConnection = { actorId, filePath, db, activeTransactions: 0 };
    this.connections.set(actorId, conn);
    return conn;
  }

  private async closeConnection(conn: ActorConnection): Promise<void> {
    try {
      await conn.db.close?.();
    } catch {}
  }

  /**
   * Internal hook called by transactions when closed.
   */
  _decrementActiveTransactions(actorId: string): void {
    const conn = this.connections.get(actorId);
    if (conn && conn.activeTransactions > 0) {
      conn.activeTransactions--;
    }
  }

  /**
   * Explicitly closes an actor's database connection.
   */
  async closeActor(actorId: string): Promise<void> {
    const conn = this.connections.get(actorId);
    if (conn) {
      this.connections.delete(actorId);
      await this.closeConnection(conn);
    }
  }

  /**
   * Returns the underlying SqlDatabase for an actor (e.g. for migrations or raw SQL).
   */
  async getDatabase(actorId: string): Promise<SqlDatabase> {
    const conn = await this.getConnection(actorId);
    return conn.db;
  }

  async get<T = unknown>(actorId: string, key: string): Promise<T | undefined> {
    const conn = await this.getConnection(actorId);
    const row = await conn.db.first<{ value: string }>(
      'SELECT "value" FROM "_actor_state" WHERE "key" = ?;',
      [key],
    );
    if (!row) return undefined;
    return deserializeValue<T>(row.value);
  }

  async set<T = unknown>(actorId: string, key: string, value: T): Promise<void> {
    const conn = await this.getConnection(actorId);
    await conn.db.run(UPSERT_STATE_SQL, [key, serializeValue(value), Date.now()]);
  }

  async delete(actorId: string, key: string): Promise<boolean> {
    const conn = await this.getConnection(actorId);
    const result = await conn.db.run('DELETE FROM "_actor_state" WHERE "key" = ?;', [key]);
    return typeof result?.changes === 'number' && result.changes > 0;
  }

  async has(actorId: string, key: string): Promise<boolean> {
    const conn = await this.getConnection(actorId);
    const row = await conn.db.first('SELECT 1 FROM "_actor_state" WHERE "key" = ? LIMIT 1;', [key]);
    return row !== null && row !== undefined;
  }

  async keys(actorId: string): Promise<string[]> {
    const conn = await this.getConnection(actorId);
    const rows = await conn.db.query<{ key: string }>('SELECT "key" FROM "_actor_state";');
    return rows.map((r) => r.key);
  }

  async entries<T = unknown>(actorId: string): Promise<[string, T][]> {
    const conn = await this.getConnection(actorId);
    const rows = await conn.db.query<{ key: string; value: string }>(
      'SELECT "key", "value" FROM "_actor_state";',
    );
    return rows.map((r) => [r.key, deserializeValue<T>(r.value)]);
  }

  async clear(actorId: string): Promise<void> {
    const conn = await this.getConnection(actorId);
    await conn.db.run('DELETE FROM "_actor_state";');
  }

  async clearAll(): Promise<void> {
    for (const actorId of Array.from(this.connections.keys())) {
      await this.clear(actorId);
    }
  }

  async beginTransaction(
    actorId: string,
    options?: TransactionOptions,
  ): Promise<ActorStorageTransaction> {
    const conn = await this.getConnection(actorId);
    conn.activeTransactions++;
    return new WasmSqliteActorStorageTransaction(actorId, this, conn.db, options);
  }

  async getOwnership(actorId: string): Promise<ActorOwnershipRecord | null> {
    const conn = await this.getConnection(actorId);
    const row = await conn.db.first<OwnershipRow>(SELECT_OWNERSHIP_SQL);
    if (!row) return null;
    return {
      actorId,
      ownerId: row.owner_id,
      generation: Number(row.generation),
      acquiredAt: Number(row.acquired_at),
      leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    };
  }

  async acquireOwnership(
    actorId: string,
    ownerId: string,
    options?: { leaseTtlMs?: number; force?: boolean },
  ): Promise<ActorOwnershipRecord> {
    const conn = await this.getConnection(actorId);
    const db = conn.db;

    await db.exec('BEGIN IMMEDIATE;');
    try {
      const row = await db.first<OwnershipRow>(SELECT_OWNERSHIP_SQL);
      const now = Date.now();
      const leaseExpiresAt = options?.leaseTtlMs ? now + options.leaseTtlMs : null;

      let result: ActorOwnershipRecord;
      if (!row) {
        await db.run(
          'INSERT INTO "_actor_ownership" ("id", "owner_id", "generation", "acquired_at", "lease_expires_at") VALUES (1, ?, 1, ?, ?);',
          [ownerId, now, leaseExpiresAt],
        );
        result = { actorId, ownerId, generation: 1, acquiredAt: now, leaseExpiresAt };
      } else if (row.owner_id === ownerId) {
        await db.run(
          'UPDATE "_actor_ownership" SET "acquired_at" = ?, "lease_expires_at" = ? WHERE id = 1;',
          [now, leaseExpiresAt],
        );
        result = {
          actorId,
          ownerId,
          generation: Number(row.generation),
          acquiredAt: now,
          leaseExpiresAt,
        };
      } else {
        const currentLease = row.lease_expires_at === null ? null : Number(row.lease_expires_at);
        const isExpired = currentLease != null && currentLease < now;
        if (isExpired || options?.force) {
          const nextGen = Number(row.generation) + 1;
          await db.run(
            'UPDATE "_actor_ownership" SET "owner_id" = ?, "generation" = ?, "acquired_at" = ?, "lease_expires_at" = ? WHERE id = 1;',
            [ownerId, nextGen, now, leaseExpiresAt],
          );
          result = { actorId, ownerId, generation: nextGen, acquiredAt: now, leaseExpiresAt };
        } else {
          throw new ActorOwnershipConflictError(
            actorId,
            row.owner_id,
            Number(row.generation),
            currentLease,
          );
        }
      }
      await db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        await db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }

  async releaseOwnership(actorId: string, ownerId: string): Promise<boolean> {
    const conn = await this.getConnection(actorId);
    const res = await conn.db.run('DELETE FROM "_actor_ownership" WHERE id = 1 AND owner_id = ?;', [
      ownerId,
    ]);
    return (res?.changes ?? 0) > 0;
  }

  async getIdempotencyRecord(
    actorId: string,
    requestId: string,
  ): Promise<{ response: unknown; createdAt: number } | undefined> {
    const conn = await this.getConnection(actorId);
    const row = await conn.db.first<{ response: string; created_at: number }>(
      'SELECT "response", "created_at" FROM "_actor_idempotency" WHERE "request_id" = ?;',
      [requestId],
    );
    if (!row) return undefined;
    return {
      response: deserializeValue(row.response),
      createdAt: Number(row.created_at),
    };
  }

  async setIdempotencyRecord(actorId: string, requestId: string, response: unknown): Promise<void> {
    const conn = await this.getConnection(actorId);
    await conn.db.run(UPSERT_IDEMPOTENCY_SQL, [requestId, serializeValue(response), Date.now()]);
  }

  /**
   * Diagnostic helper to dump committed state for an actor.
   */
  async dump(actorId: string): Promise<Record<string, any>> {
    const entries = await this.entries(actorId);
    const obj: Record<string, any> = {};
    for (const [k, v] of entries) obj[k] = v;
    return obj;
  }

  /**
   * Closes all open actor connections. Further use throws.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Let any in-flight opens settle so their connections can be closed too.
    const inflight = Array.from(this.pending.values());
    for (const p of inflight) {
      try {
        await p;
      } catch {}
    }

    const conns = Array.from(this.connections.values());
    this.connections.clear();
    for (const conn of conns) {
      await this.closeConnection(conn);
    }
  }
}
