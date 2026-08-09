import type { ConditionalStorageAdapter } from './adapter.js';
import { EntityRepository } from './repository.js';
import type { EntityId, PaginatedResult } from './types.js';

export class InMemoryRepository<E extends { id: ID }, ID extends string | number = EntityId>
  extends EntityRepository<E, ID>
  implements ConditionalStorageAdapter<E, ID>
{
  protected items = new Map<ID, E>();

  constructor() {
    super(undefined as any);
  }

  async findById(id: ID): Promise<E | null> {
    return this.items.get(this.normalizeId(id)) || null;
  }

  async findAll(): Promise<E[]> {
    return Array.from(this.items.values());
  }

  async findMany(ids: ID[]): Promise<E[]> {
    return ids.map((id) => this.items.get(this.normalizeId(id))).filter((e): e is E => !!e);
  }

  async save(entity: E): Promise<E> {
    this.items.set(this.normalizeId(entity.id), entity);
    return entity;
  }

  async delete(id: ID): Promise<boolean> {
    return this.items.delete(this.normalizeId(id));
  }

  async upsert(entity: E): Promise<E> {
    return this.save(entity);
  }

  async findPaginated(params: {
    page?: number;
    size?: number;
    [p: string]: unknown;
  }): Promise<PaginatedResult<E>> {
    const page = params.page || 1;
    const size = params.size || 10;
    const all = await this.findAll();

    // Filter out other params (simple exact match for this in-memory implementation)
    const filters = Object.entries(params).filter(([key]) => key !== 'page' && key !== 'size');
    const filtered = all.filter((item) => {
      return filters.every(([key, value]) => (item as any)[key] === value);
    });

    const start = (page - 1) * size;
    const items = filtered.slice(start, start + size);
    return {
      items,
      total: filtered.length,
      page,
      size,
      pages: Math.ceil(filtered.length / size),
    };
  }

  async saveIfAbsent(entity: E): Promise<boolean> {
    const normId = this.normalizeId(entity.id);
    if (this.items.has(normId)) {
      return false;
    }
    this.items.set(normId, entity);
    return true;
  }

  async compareAndSwap(id: ID, mutate: (current: E | null) => E | null): Promise<boolean> {
    const normId = this.normalizeId(id);
    const current = this.items.get(normId) ?? null;
    const next = mutate(current);
    if (next === null) {
      return false;
    }
    this.items.set(normId, next);
    return true;
  }
}
