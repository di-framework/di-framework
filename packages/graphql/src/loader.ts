/**
 * Minimal batching loader.
 *
 * Same shape as DataLoader, without the dependency: `load()` returns a promise,
 * and every key requested before the batch is dispatched is passed to the batch
 * function in one call. Dispatch is deferred by two microtask hops so that a
 * whole GraphQL resolution level has enqueued its keys first.
 */

export type BatchFunction<K, V> = (keys: K[]) => V[] | Promise<V[]>;

export class BatchLoader<K, V> {
  private queue: Array<{ key: K; resolve: (value: V) => void; reject: (error: unknown) => void }> =
    [];
  private readonly cache = new Map<K, Promise<V>>();
  private scheduled = false;

  constructor(private readonly batchFn: BatchFunction<K, V>) {}

  load(key: K): Promise<V> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = new Promise<V>((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
    });
    this.cache.set(key, promise);
    this.schedule();
    return promise;
  }

  loadMany(keys: K[]): Promise<V[]> {
    return Promise.all(keys.map((key) => this.load(key)));
  }

  clear(): void {
    this.cache.clear();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    Promise.resolve().then(() => queueMicrotask(() => void this.dispatch()));
  }

  private async dispatch(): Promise<void> {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;

    try {
      const results = await this.batchFn(batch.map((entry) => entry.key));
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error(
          `Batch function must return an array of ${batch.length} results, one per key (got ${
            Array.isArray(results) ? results.length : typeof results
          }).`,
        );
      }
      batch.forEach((entry, index) => {
        entry.resolve(results[index] as V);
      });
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    }
  }
}
