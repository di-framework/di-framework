/**
 * In-memory transactional storage implementation for @di-framework/actors.
 */
import { ActorOwnershipConflictError, StaleOwnerWriteError } from '../distributed/errors';
import type { ActorOwnershipRecord } from '../distributed/types';
import type { ActorStorage, ActorStorageTransaction, TransactionOptions } from './types';

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' && typeof value !== 'function') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * Isolated transaction for in-memory actor storage.
 */
export class InMemoryActorStorageTransaction implements ActorStorageTransaction {
  private readonly actorId: string;
  private readonly storage: InMemoryActorStorage;
  private readonly ownerId?: string;
  private readonly generation?: number;
  private readonly stagedSets = new Map<string, any>();
  private readonly stagedDeletes = new Set<string>();
  private stagedIdempotency?: { requestId: string; response: unknown };
  private clearAllStaged = false;
  private closed = false;

  constructor(actorId: string, storage: InMemoryActorStorage, options?: TransactionOptions) {
    this.actorId = actorId;
    this.storage = storage;
    this.ownerId = options?.ownerId;
    this.generation = options?.generation;
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
    return this.storage.has(this.actorId, key);
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
    return this.storage.has(this.actorId, key);
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
    if (this.generation !== undefined) {
      const current = await this.storage.getOwnership(this.actorId);
      if (
        current &&
        (current.generation > this.generation || (this.ownerId && current.ownerId !== this.ownerId))
      ) {
        throw new StaleOwnerWriteError(
          this.actorId,
          this.generation,
          current.generation,
          current.ownerId,
        );
      }
    }
    this.storage._applyTransactionCommit(this.actorId, {
      clearAll: this.clearAllStaged,
      sets: this.stagedSets,
      deletes: this.stagedDeletes,
    });
    if (this.stagedIdempotency) {
      await this.storage.setIdempotencyRecord(
        this.actorId,
        this.stagedIdempotency.requestId,
        this.stagedIdempotency.response,
      );
    }
    this.closed = true;
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.stagedSets.clear();
    this.stagedDeletes.clear();
    this.clearAllStaged = false;
    this.closed = true;
  }
}

/**
 * In-memory transactional storage provider.
 */
export class InMemoryActorStorage implements ActorStorage {
  private readonly state = new Map<string, Map<string, any>>();
  private readonly ownership = new Map<string, ActorOwnershipRecord>();
  private readonly idempotency = new Map<
    string,
    Map<string, { response: unknown; createdAt: number }>
  >();

  private getActorMap(actorId: string): Map<string, any> {
    let map = this.state.get(actorId);
    if (!map) {
      map = new Map<string, any>();
      this.state.set(actorId, map);
    }
    return map;
  }

  async get<T = unknown>(actorId: string, key: string): Promise<T | undefined> {
    const map = this.state.get(actorId);
    if (!map || !map.has(key)) return undefined;
    return cloneValue(map.get(key) as T);
  }

  async set<T = unknown>(actorId: string, key: string, value: T): Promise<void> {
    const map = this.getActorMap(actorId);
    map.set(key, cloneValue(value));
  }

  async delete(actorId: string, key: string): Promise<boolean> {
    const map = this.state.get(actorId);
    if (!map) return false;
    return map.delete(key);
  }

  async has(actorId: string, key: string): Promise<boolean> {
    const map = this.state.get(actorId);
    return map ? map.has(key) : false;
  }

  async keys(actorId: string): Promise<string[]> {
    const map = this.state.get(actorId);
    return map ? Array.from(map.keys()) : [];
  }

  async entries<T = unknown>(actorId: string): Promise<[string, T][]> {
    const map = this.state.get(actorId);
    if (!map) return [];
    const entries: [string, T][] = [];
    for (const [k, v] of map.entries()) {
      entries.push([k, cloneValue(v as T)]);
    }
    return entries;
  }

  async clear(actorId: string): Promise<void> {
    this.state.delete(actorId);
  }

  async clearAll(): Promise<void> {
    this.state.clear();
  }

  async beginTransaction(
    actorId: string,
    options?: TransactionOptions,
  ): Promise<ActorStorageTransaction> {
    return new InMemoryActorStorageTransaction(actorId, this, options);
  }

  async getOwnership(actorId: string): Promise<ActorOwnershipRecord | null> {
    const rec = this.ownership.get(actorId);
    if (!rec) return null;
    return { ...rec };
  }

  async acquireOwnership(
    actorId: string,
    ownerId: string,
    options?: { leaseTtlMs?: number; force?: boolean },
  ): Promise<ActorOwnershipRecord> {
    const existing = this.ownership.get(actorId);
    const now = Date.now();
    const leaseExpiresAt = options?.leaseTtlMs ? now + options.leaseTtlMs : null;

    if (!existing) {
      const record: ActorOwnershipRecord = {
        actorId,
        ownerId,
        generation: 1,
        acquiredAt: now,
        leaseExpiresAt,
      };
      this.ownership.set(actorId, record);
      return { ...record };
    }

    if (existing.ownerId === ownerId) {
      existing.acquiredAt = now;
      existing.leaseExpiresAt = leaseExpiresAt;
      return { ...existing };
    }

    const isExpired = existing.leaseExpiresAt != null && existing.leaseExpiresAt < now;
    if (isExpired || options?.force) {
      const record: ActorOwnershipRecord = {
        actorId,
        ownerId,
        generation: existing.generation + 1,
        acquiredAt: now,
        leaseExpiresAt,
      };
      this.ownership.set(actorId, record);
      return { ...record };
    }

    throw new ActorOwnershipConflictError(
      actorId,
      existing.ownerId,
      existing.generation,
      existing.leaseExpiresAt,
    );
  }

  async releaseOwnership(actorId: string, ownerId: string): Promise<boolean> {
    const existing = this.ownership.get(actorId);
    if (existing && existing.ownerId === ownerId) {
      return this.ownership.delete(actorId);
    }
    return false;
  }

  async getIdempotencyRecord(
    actorId: string,
    requestId: string,
  ): Promise<{ response: unknown; createdAt: number } | undefined> {
    const actorMap = this.idempotency.get(actorId);
    const record = actorMap?.get(requestId);
    if (!record) return undefined;
    return { response: cloneValue(record.response), createdAt: record.createdAt };
  }

  async setIdempotencyRecord(actorId: string, requestId: string, response: unknown): Promise<void> {
    let actorMap = this.idempotency.get(actorId);
    if (!actorMap) {
      actorMap = new Map();
      this.idempotency.set(actorId, actorMap);
    }
    actorMap.set(requestId, { response: cloneValue(response), createdAt: Date.now() });
  }

  /**
   * Internal method invoked by InMemoryActorStorageTransaction on commit.
   */
  _applyTransactionCommit(
    actorId: string,
    changes: {
      clearAll: boolean;
      sets: Map<string, any>;
      deletes: Set<string>;
    },
  ): void {
    if (changes.clearAll) {
      this.state.delete(actorId);
    }
    const map = this.getActorMap(actorId);
    for (const key of changes.deletes) {
      map.delete(key);
    }
    for (const [key, value] of changes.sets) {
      map.set(key, cloneValue(value));
    }
    if (map.size === 0) {
      this.state.delete(actorId);
    }
  }

  /**
   * Diagnostic helper to dump committed state for an actor.
   */
  dump(actorId: string): Record<string, any> {
    const map = this.state.get(actorId);
    if (!map) return {};
    const obj: Record<string, any> = {};
    for (const [k, v] of map.entries()) {
      obj[k] = cloneValue(v);
    }
    return obj;
  }
}
