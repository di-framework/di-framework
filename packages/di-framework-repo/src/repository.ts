import type { StorageAdapter } from './adapter';
import { withDerivedQueries } from './query-derivation';
import type { EntityId, PaginatedResult } from './types';

export abstract class BaseRepository<E, ID = EntityId> {
  /**
   * Returns a Proxy that derives `findBy…` / `existsBy…` / … at call time.
   * For IDE completion, assert the variable type, e.g.
   * `const repo = new InMemoryRepository<User, string>() as Derived<InMemoryRepository<User, string>>`.
   */
  protected constructor(protected readonly adapter: StorageAdapter<E, ID>) {
    // Intentionally return a Proxy so `new Subclass()` is already derivation-enabled.
    // biome-ignore lint/correctness/noConstructorReturn: proxy wrap for derived query methods
    return withDerivedQueries(this as BaseRepository<E, ID>) as this;
  }

  protected normalizeId(id: ID): ID {
    // Default normalization (stringify) – can be overridden by subclasses if needed
    return typeof id === 'string' ? (id as any) : (String(id) as any);
  }

  // Forward most calls directly (you can add caching, validation, events here)
  async findById(id: ID): Promise<E | null> {
    return this.adapter.findById(this.normalizeId(id));
  }

  async findAll(): Promise<E[]> {
    return this.adapter.findAll();
  }

  async findMany(ids: ID[]): Promise<E[]> {
    return this.adapter.findMany(ids.map((id) => this.normalizeId(id)));
  }

  async save(entity: E): Promise<E> {
    return this.adapter.save(entity);
  }

  async delete(id: ID): Promise<boolean> {
    return this.adapter.delete(this.normalizeId(id));
  }

  async findPaginated(params: {
    page?: number;
    size?: number;
    [key: string]: unknown;
  }): Promise<PaginatedResult<E>> {
    return this.adapter.findPaginated(params as any);
  }

  // Transaction support (if adapter provides it)
  protected async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof this.adapter.transaction === 'function') {
      return this.adapter.transaction(() => fn());
    }
    return fn(); // fallback
  }

  async dispose(): Promise<void> {
    if (typeof this.adapter.dispose === 'function') {
      await this.adapter.dispose();
    }
  }
}

export type Database<T extends Record<string, typeof BaseRepository>> = {
  [K in keyof T]: T[K] extends new (
    ...args: any[]
  ) => infer R
    ? R
    : T[K] extends { prototype: infer P }
      ? P
      : never;
};

export type RepositoryMap<T> = {
  [K in keyof T]: T[K] extends BaseRepository<infer E> ? BaseRepository<E> : never;
};

export abstract class EntityRepository<E, ID = EntityId> extends BaseRepository<E, ID> {
  // Explicit (even though it only forwards) so construction itself is a
  // coverable, named function rather than a compiler-synthesized one.
  protected constructor(adapter: StorageAdapter<E, ID>) {
    super(adapter);
  }
}

export type EntityOf<R> = R extends BaseRepository<infer E> ? E : never;
export type IdOf<R> = R extends BaseRepository<any, infer ID> ? ID : never;

export interface SoftDeletable {
  deletedAt: Date | null;
}

export abstract class SoftDeleteRepository<
  E extends SoftDeletable & { id: ID },
  ID = EntityId,
> extends EntityRepository<E, ID> {
  protected constructor(adapter: StorageAdapter<E, ID>) {
    super(adapter);
  }

  abstract softDelete(id: ID): Promise<boolean>;
  abstract restore(id: ID): Promise<boolean>;
  abstract findActive(): Promise<E[]>;
  abstract findDeleted(): Promise<E[]>;

  protected abstract afterNotifyDelete(id: ID): void;

  async softDeleteAndNotify(id: ID): Promise<boolean> {
    const ok = await this.softDelete(id);
    if (ok) this.afterNotifyDelete(id);
    return ok;
  }
}

export interface SearchableRepository<E, _ID = EntityId> {
  search(query: string, params?: { page?: number; size?: number }): Promise<PaginatedResult<E>>;
}
