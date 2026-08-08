/**
 * Minimal protocol that every storage backend must implement.
 * Keeps repository layer agnostic to the underlying technology.
 */
export interface StorageAdapter<E, ID = string | number> {
  /**
   * Retrieve one entity by ID
   */
  findById(id: ID): Promise<E | null>;

  /**
   * Retrieve multiple entities by IDs
   */
  findMany(ids: ID[]): Promise<E[]>;

  /**
   * Retrieve all entities (use with care – pagination usually preferred)
   */
  findAll(): Promise<E[]>;

  /**
   * Create or update (most implementations do upsert under the hood)
   */
  save(entity: E): Promise<E>;

  /**
   * Delete by ID – returns whether deletion actually occurred
   */
  delete(id: ID): Promise<boolean>;

  /**
   * Optional: count matching records (used for pagination metadata)
   */
  count(filter?: Record<string, any>): Promise<number>;

  /**
   * Optional: exists check (cheaper than findById in many backends)
   */
  exists(id: ID): Promise<boolean>;

  /**
   * Paginated listing with basic filtering/sorting support
   * Filter/sort format is deliberately loose – concrete adapters interpret it.
   */
  findPaginated(params: {
    page?: number;
    size?: number;
    sort?: string | string[]; // "createdAt:desc" or ["name:asc", "age:desc"]
    filter?: Record<string, any>; // { status: "active", age: { gte: 18 } }
    withDeleted?: boolean;
  }): Promise<{
    items: E[];
    total: number;
    page: number;
    size: number;
    pages: number;
  }>;

  /**
   * Optional – transaction support
   * Return value of fn is returned from the transaction
   */
  transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T>;

  /**
   * Optional – clean up / disconnect (important for tests, lambda, etc.)
   */
  dispose?(): Promise<void> | void;
}

/**
 * Factory signature – allows dynamic creation of adapters
 */
export type StorageAdapterFactory<E, ID = string | number> = (
  config: unknown, // connection string, options, credentials, etc.
  entityName?: string, // useful for table/collection name inference
) => Promise<StorageAdapter<E, ID>> | StorageAdapter<E, ID>;

/**
 * Helper type to extract Entity & ID from an adapter
 */
export type EntityOfAdapter<A> = A extends StorageAdapter<infer E, any> ? E : never;
export type IdOfAdapter<A> = A extends StorageAdapter<any, infer ID> ? ID : never;

/**
 * Interface for adapters that support atomic conditional write operations.
 */
export interface ConditionalStorageAdapter<E, ID = string | number> {
  /**
   * Save `entity` only if no record with its ID exists.
   * Return true if inserted, false if record already exists.
   */
  saveIfAbsent(entity: E): Promise<boolean>;

  /**
   * Apply synchronous, side-effect-free `mutate` function to record at `id` atomically.
   * Return true if write landed, false if condition failed or entity missing / mutated (i.e. mutate returned null).
   */
  compareAndSwap(id: ID, mutate: (current: E | null) => E | null): Promise<boolean>;
}

/**
 * Type guard to check if an adapter supports conditional write operations.
 */
export function supportsConditionalWrite<E, ID = string | number>(
  adapter: unknown,
): adapter is ConditionalStorageAdapter<E, ID> {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as any).saveIfAbsent === 'function' &&
    typeof (adapter as any).compareAndSwap === 'function'
  );
}
