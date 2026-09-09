/**
 * SQLite storage adapter for @di-framework/actors.
 * Provides per-actor lazily-opened SQLite databases, bounded connection caching,
 * idle connection cleanup, single-writer process locking, and ACID transactions.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireActorLock } from './lock.js';
import { actorIdentityToPath } from './path.js';
import type { ActorStorage, ActorStorageTransaction } from './types.js';

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

export interface SqliteActorStorageOptions {
  /**
   * Base directory where actor SQLite databases are stored on disk.
   * Defaults to '.actors'.
   */
  baseDir?: string;

  /**
   * Run SQLite databases in-memory (using isolated shared memory URIs).
   */
  inMemory?: boolean;

  /**
   * If true, creates a temporary directory on disk that is deleted on close().
   */
  temp?: boolean;

  /**
   * Maximum number of database connections to cache concurrently.
   * Defaults to 50.
   */
  maxConnections?: number;

  /**
   * Idle timeout in milliseconds after which unused connections are closed and evicted.
   * Defaults to 30000 (30 seconds). Set to 0 to disable idle cleanup timer.
   */
  idleTimeoutMs?: number;

  /**
   * Enable file-based single writer locking.
   * Defaults to true.
   */
  fileLocking?: boolean;

  /**
   * Retained for compatibility. A live process lock is never stolen based on age.
   */
  lockTimeoutMs?: number;
}

interface CachedConnection {
  actorId: string;
  filePath: string;
  db: Database;
  releaseLock?: () => Promise<void>;
  lastUsed: number;
  activeTransactions: number;
}

/**
 * Isolated transaction for SQLite actor storage.
 */
export class SqliteActorStorageTransaction implements ActorStorageTransaction {
  private readonly actorId: string;
  private readonly storage: SqliteActorStorage;
  private readonly db: Database;
  private readonly stagedSets = new Map<string, any>();
  private readonly stagedDeletes = new Set<string>();
  private clearAllStaged = false;
  private closed = false;

  constructor(actorId: string, storage: SqliteActorStorage, db: Database) {
    this.actorId = actorId;
    this.storage = storage;
    this.db = db;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Transaction has already been closed (committed or rolled back).');
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    this.assertOpen();
    if (this.stagedDeletes.has(key)) {
      return undefined;
    }
    if (this.stagedSets.has(key)) {
      return cloneValue(this.stagedSets.get(key) as T);
    }
    if (this.clearAllStaged) {
      return undefined;
    }
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
    if (this.stagedDeletes.has(key)) {
      return false;
    }
    if (this.stagedSets.has(key)) {
      return true;
    }
    if (this.clearAllStaged) {
      return false;
    }
    return await this.storage.has(this.actorId, key);
  }

  async keys(): Promise<string[]> {
    this.assertOpen();
    const keySet = new Set<string>();
    if (!this.clearAllStaged) {
      const committedKeys = await this.storage.keys(this.actorId);
      for (const k of committedKeys) {
        if (!this.stagedDeletes.has(k)) {
          keySet.add(k);
        }
      }
    }
    for (const k of this.stagedSets.keys()) {
      keySet.add(k);
    }
    return Array.from(keySet);
  }

  async entries<T = unknown>(): Promise<[string, T][]> {
    this.assertOpen();
    const allKeys = await this.keys();
    const result: [string, T][] = [];
    for (const key of allKeys) {
      const val = await this.get<T>(key);
      if (val !== undefined) {
        result.push([key, val]);
      }
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

    db.run('BEGIN IMMEDIATE;');
    try {
      if (this.clearAllStaged) {
        db.run('DELETE FROM "_actor_state";');
      }
      if (this.stagedDeletes.size > 0) {
        const delStmt = db.prepare('DELETE FROM "_actor_state" WHERE "key" = ?;');
        for (const key of this.stagedDeletes) {
          delStmt.run(key);
        }
      }
      if (this.stagedSets.size > 0) {
        const upsertStmt = db.prepare(
          'INSERT INTO "_actor_state" ("key", "value", "updated_at") VALUES (?, ?, ?) ' +
            'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at";',
        );
        const now = Date.now();
        for (const [key, value] of this.stagedSets.entries()) {
          upsertStmt.run(key, serializeValue(value), now);
        }
      }
      db.run('COMMIT;');
    } catch (err) {
      try {
        db.run('ROLLBACK;');
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

  getDatabase(): Database {
    return this.db;
  }
}

/**
 * SQLite Actor Storage Provider.
 */
export class SqliteActorStorage implements ActorStorage {
  readonly baseDir: string;
  readonly inMemory: boolean;
  readonly temp: boolean;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly fileLocking: boolean;
  readonly lockTimeoutMs: number;

  private readonly connections = new Map<string, CachedConnection>();
  private readonly inMemoryKeepAlive = new Map<string, Database>();
  private idleCleanupTimer: any = null;
  private closed = false;

  constructor(options: SqliteActorStorageOptions = {}) {
    this.inMemory = options.inMemory === true || options.baseDir === ':memory:';
    this.temp = options.temp === true;
    this.baseDir = options.baseDir ?? (this.inMemory ? ':memory:' : '.actors');
    this.maxConnections = options.maxConnections ?? 50;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    this.fileLocking = options.fileLocking ?? !this.inMemory;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30000;

    if (this.idleTimeoutMs > 0) {
      const interval = Math.max(1000, Math.min(this.idleTimeoutMs, 10000));
      this.idleCleanupTimer = setInterval(() => {
        this.cleanupIdleConnections().catch(() => {});
      }, interval);
      if (typeof this.idleCleanupTimer.unref === 'function') {
        this.idleCleanupTimer.unref();
      }
    }
  }

  /**
   * Factory method creating a SQLite storage adapter in a fresh temporary directory on disk.
   * Cleans up the directory when storage.close() is called.
   */
  static temporary(
    options: Omit<SqliteActorStorageOptions, 'baseDir' | 'temp'> = {},
  ): SqliteActorStorage {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-sqlite-'));
    return new SqliteActorStorage({
      ...options,
      baseDir: tmpDir,
      temp: true,
    });
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error('SqliteActorStorage has already been closed.');
    }
  }

  /**
   * Lazily opens and caches the SQLite database connection for an actor.
   * Manages bounded cache eviction and process locks.
   */
  async getConnection(actorId: string): Promise<CachedConnection> {
    this.assertNotClosed();

    let conn = this.connections.get(actorId);
    if (conn) {
      conn.lastUsed = Date.now();
      return conn;
    }

    // Enforce bounded connection caching: evict LRU idle connection if over limit
    if (this.connections.size >= this.maxConnections) {
      let oldest: CachedConnection | null = null;
      for (const candidate of this.connections.values()) {
        if (candidate.activeTransactions === 0) {
          if (!oldest || candidate.lastUsed < oldest.lastUsed) {
            oldest = candidate;
          }
        }
      }
      if (oldest) {
        await this.closeConnection(oldest);
        this.connections.delete(oldest.actorId);
      }
    }

    const filePath = actorIdentityToPath(actorId, {
      baseDir: this.baseDir,
      inMemory: this.inMemory,
    });

    // Acquire lock if locking enabled
    let releaseLock: (() => Promise<void>) | undefined;
    if (this.fileLocking) {
      releaseLock = await acquireActorLock(filePath, actorId, {
        lockTimeoutMs: this.lockTimeoutMs,
        inMemory: this.inMemory,
      });
    }

    if (!this.inMemory) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const db = new Database(filePath);
    try {
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA synchronous = NORMAL;');
      db.run(`
        CREATE TABLE IF NOT EXISTS "_actor_state" (
          "key" TEXT PRIMARY KEY,
          "value" TEXT NOT NULL,
          "updated_at" INTEGER NOT NULL
        );
      `);
    } catch (err) {
      if (releaseLock) {
        await releaseLock();
      }
      db.close();
      throw err;
    }

    // Keep memory DB alive so LRU cache eviction doesn't erase in-memory data for tests
    if (this.inMemory && !this.inMemoryKeepAlive.has(actorId)) {
      this.inMemoryKeepAlive.set(actorId, db);
    }

    conn = {
      actorId,
      filePath,
      db,
      releaseLock,
      lastUsed: Date.now(),
      activeTransactions: 0,
    };

    this.connections.set(actorId, conn);
    return conn;
  }

  private async closeConnection(conn: CachedConnection): Promise<void> {
    try {
      conn.db.close();
    } catch {}
    if (conn.releaseLock) {
      try {
        await conn.releaseLock();
      } catch {}
    }
  }

  /**
   * Internal hook called by transactions when closed.
   */
  _decrementActiveTransactions(actorId: string): void {
    const conn = this.connections.get(actorId);
    if (conn && conn.activeTransactions > 0) {
      conn.activeTransactions--;
      conn.lastUsed = Date.now();
    }
  }

  /**
   * Inspects all cached connections and closes those that have been idle
   * for longer than idleTimeoutMs and have no active transactions.
   */
  async cleanupIdleConnections(): Promise<number> {
    if (this.closed) return 0;
    const now = Date.now();
    const toEvict: CachedConnection[] = [];

    for (const conn of this.connections.values()) {
      if (conn.activeTransactions === 0 && now - conn.lastUsed >= this.idleTimeoutMs) {
        toEvict.push(conn);
      }
    }

    for (const conn of toEvict) {
      await this.closeConnection(conn);
      this.connections.delete(conn.actorId);
    }

    return toEvict.length;
  }

  /**
   * Explicitly closes and unlocks an actor's database connection.
   */
  async closeActor(actorId: string): Promise<void> {
    const conn = this.connections.get(actorId);
    if (conn) {
      await this.closeConnection(conn);
      this.connections.delete(actorId);
    }
  }

  /**
   * Returns the underlying Database instance for an actor (e.g. for migrations or raw SQL).
   */
  async getDatabase(actorId: string): Promise<Database> {
    const conn = await this.getConnection(actorId);
    return conn.db;
  }

  async get<T = unknown>(actorId: string, key: string): Promise<T | undefined> {
    const conn = await this.getConnection(actorId);
    const row = conn.db.query('SELECT "value" FROM "_actor_state" WHERE "key" = ?;').get(key) as
      | { value: string }
      | null
      | undefined;

    if (!row) return undefined;
    return deserializeValue<T>(row.value);
  }

  async set<T = unknown>(actorId: string, key: string, value: T): Promise<void> {
    const conn = await this.getConnection(actorId);
    const stmt = conn.db.prepare(
      'INSERT INTO "_actor_state" ("key", "value", "updated_at") VALUES (?, ?, ?) ' +
        'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at";',
    );
    stmt.run(key, serializeValue(value), Date.now());
  }

  async delete(actorId: string, key: string): Promise<boolean> {
    const conn = await this.getConnection(actorId);
    const stmt = conn.db.prepare('DELETE FROM "_actor_state" WHERE "key" = ?;');
    const result = stmt.run(key);
    return typeof result?.changes === 'number' && result.changes > 0;
  }

  async has(actorId: string, key: string): Promise<boolean> {
    const conn = await this.getConnection(actorId);
    const row = conn.db.query('SELECT 1 FROM "_actor_state" WHERE "key" = ? LIMIT 1;').get(key);
    return row !== null && row !== undefined;
  }

  async keys(actorId: string): Promise<string[]> {
    const conn = await this.getConnection(actorId);
    const rows = conn.db.query('SELECT "key" FROM "_actor_state";').all() as { key: string }[];
    return rows.map((r) => r.key);
  }

  async entries<T = unknown>(actorId: string): Promise<[string, T][]> {
    const conn = await this.getConnection(actorId);
    const rows = conn.db.query('SELECT "key", "value" FROM "_actor_state";').all() as {
      key: string;
      value: string;
    }[];
    return rows.map((r) => [r.key, deserializeValue<T>(r.value)]);
  }

  async clear(actorId: string): Promise<void> {
    const conn = await this.getConnection(actorId);
    conn.db.run('DELETE FROM "_actor_state";');
  }

  async clearAll(): Promise<void> {
    for (const actorId of this.connections.keys()) {
      await this.clear(actorId);
    }
  }

  async beginTransaction(actorId: string): Promise<ActorStorageTransaction> {
    const conn = await this.getConnection(actorId);
    conn.activeTransactions++;
    return new SqliteActorStorageTransaction(actorId, this, conn.db);
  }

  /**
   * Diagnostic helper to dump committed state for an actor.
   */
  async dump(actorId: string): Promise<Record<string, any>> {
    const entries = await this.entries(actorId);
    const obj: Record<string, any> = {};
    for (const [k, v] of entries) {
      obj[k] = v;
    }
    return obj;
  }

  /**
   * Closes all active connections, releases all locks, and clears background timers.
   * If this storage adapter was created with temp: true, removes the temporary directory.
   */

  /**
   * Scoped reset / clean of persisted SQLite database files.
   * Closes active connections matching scope and removes files from disk.
   */
  async resetStorage(scope: {
    namespace?: string;
    actorName?: string;
    actorKey?: string;
    all?: boolean;
  }): Promise<string[]> {
    const deletedFiles: string[] = [];
    const { namespace, actorName, actorKey, all } = scope;

    if (!all && !namespace && !actorName) {
      throw new Error("resetStorage requires explicit scope: namespace, actorName, or all: true.");
    }

    // 1. Close active connections matching the scope
    for (const [actorId, conn] of Array.from(this.connections.entries())) {
      const parts = actorId.split(":");
      const connNs = parts.length >= 3 ? parts[0] : undefined;
      const connType = parts.length >= 3 ? parts[1] : parts[0];
      const connKey = parts.length >= 3 ? parts.slice(2).join(":") : parts.slice(1).join(":");

      let match = false;
      if (all) match = true;
      else if (namespace && !actorName && connNs === namespace) match = true;
      else if (actorName && !namespace && connType === actorName) {
        if (!actorKey || connKey === actorKey) match = true;
      } else if (namespace && actorName && connNs === namespace && connType === actorName) {
        if (!actorKey || connKey === actorKey) match = true;
      }

      if (match) {
        await this.closeConnection(conn);
        this.connections.delete(actorId);
        if (this.inMemoryKeepAlive.has(actorId)) {
          try { this.inMemoryKeepAlive.get(actorId)?.close(); } catch {}
          this.inMemoryKeepAlive.delete(actorId);
        }
      }
    }

    // 2. In-memory mode does not have disk files to delete
    if (this.inMemory) {
      return deletedFiles;
    }

    const resolvedBase = path.resolve(this.baseDir);
    if (!fs.existsSync(resolvedBase)) {
      return deletedFiles;
    }

    if (all) {
      const entries = fs.readdirSync(resolvedBase);
      for (const entry of entries) {
        const full = path.join(resolvedBase, entry);
        deletedFiles.push(full);
        fs.rmSync(full, { recursive: true, force: true });
      }
      return deletedFiles;
    }

    if (namespace && !actorName) {
      const safeNs = (namespace || "default").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "default";
      const targetDir = path.join(resolvedBase, safeNs);
      if (fs.existsSync(targetDir)) {
        deletedFiles.push(targetDir);
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      return deletedFiles;
    }

    if (actorName && !actorKey) {
      const safeName = actorName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "actor";
      // Find matching directories across namespaces
      const namespaces = namespace ? [namespace] : fs.readdirSync(resolvedBase);
      for (const ns of namespaces) {
        const safeNs = (ns || "default").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "default";
        const targetDir = path.join(resolvedBase, safeNs, safeName);
        if (fs.existsSync(targetDir)) {
          deletedFiles.push(targetDir);
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
      }
      return deletedFiles;
    }

    if (actorName && actorKey) {
      const dbPath = actorIdentityToPath(
        { namespace, actorName, actorKey },
        { baseDir: this.baseDir }
      );
      for (const ext of ["", "-wal", "-shm", ".lock"]) {
        const target = dbPath + ext;
        if (fs.existsSync(target)) {
          deletedFiles.push(target);
          try { fs.unlinkSync(target); } catch {}
        }
      }
      return deletedFiles;
    }

    return deletedFiles;
  }

  /**
   * Helper to discover actor database files persisted on disk.
   */
  async listPersistedActors(): Promise<Array<{ namespace: string; actorName: string; filePath: string }>> {
    if (this.inMemory) return [];
    const resolvedBase = path.resolve(this.baseDir);
    if (!fs.existsSync(resolvedBase)) return [];

    const results: Array<{ namespace: string; actorName: string; filePath: string }> = [];
    try {
      const namespaces = fs.readdirSync(resolvedBase, { withFileTypes: true });
      for (const nsEntry of namespaces) {
        if (!nsEntry.isDirectory()) continue;
        const nsPath = path.join(resolvedBase, nsEntry.name);
        const actors = fs.readdirSync(nsPath, { withFileTypes: true });
        for (const actEntry of actors) {
          if (!actEntry.isDirectory()) continue;
          const actPath = path.join(nsPath, actEntry.name);
          const files = fs.readdirSync(actPath, { withFileTypes: true });
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(".db")) {
              results.push({
                namespace: nsEntry.name,
                actorName: actEntry.name,
                filePath: path.join(actPath, file.name),
              });
            }
          }
        }
      }
    } catch {}
    return results;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }

    for (const conn of this.connections.values()) {
      await this.closeConnection(conn);
    }
    this.connections.clear();

    for (const db of this.inMemoryKeepAlive.values()) {
      try {
        db.close();
      } catch {}
    }
    this.inMemoryKeepAlive.clear();

    if (this.temp && this.baseDir && this.baseDir !== ':memory:' && fs.existsSync(this.baseDir)) {
      try {
        fs.rmSync(this.baseDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
