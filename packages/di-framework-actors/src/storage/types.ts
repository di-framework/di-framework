/**
 * Storage abstractions and transaction contracts for @di-framework/actors.
 */

/**
 * Transaction interface for an actor's storage operations.
 * Isolates reads and uncommitted writes during an invocation.
 */
export interface ActorStorageTransaction {
  /**
   * Reads a value by state key within this transaction.
   * Returns staged value if modified during this transaction,
   * otherwise returns committed value.
   */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /**
   * Stages a value for the given state key.
   */
  set<T = unknown>(key: string, value: T): Promise<void>;

  /**
   * Stages a deletion of the state key.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Checks whether the state key exists in this transaction.
   */
  has(key: string): Promise<boolean>;

  /**
   * Returns all available state keys for this actor in this transaction.
   */
  keys(): Promise<string[]>;

  /**
   * Returns all state key-value entries in this transaction.
   */
  entries<T = unknown>(): Promise<[string, T][]>;

  /**
   * Clears all state keys for this actor within this transaction.
   */
  clear(): Promise<void>;

  /**
   * Commits all staged operations atomically into persistent storage.
   */
  commit(): Promise<void>;

  /**
   * Discards all staged operations without mutating persistent storage.
   */
  rollback(): Promise<void>;
}

/**
 * Storage provider interface for actors.
 * Supports transactional execution per actor.
 */
export interface ActorStorage {
  /**
   * Gets a value directly from committed storage.
   */
  get<T = unknown>(actorId: string, key: string): Promise<T | undefined>;

  /**
   * Sets a value directly in committed storage.
   */
  set<T = unknown>(actorId: string, key: string, value: T): Promise<void>;

  /**
   * Deletes a value directly from committed storage.
   */
  delete(actorId: string, key: string): Promise<boolean>;

  /**
   * Checks existence directly in committed storage.
   */
  has(actorId: string, key: string): Promise<boolean>;

  /**
   * Lists all keys for an actor directly from committed storage.
   */
  keys(actorId: string): Promise<string[]>;

  /**
   * Lists all entries for an actor directly from committed storage.
   */
  entries<T = unknown>(actorId: string): Promise<[string, T][]>;

  /**
   * Clears all state for an actor directly from committed storage.
   */
  clear(actorId: string): Promise<void>;

  /**
   * Begins an isolated storage transaction for the given actor.
   */
  beginTransaction(actorId: string): Promise<ActorStorageTransaction>;
}
