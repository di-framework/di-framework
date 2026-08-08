import { AsyncLocalStorage } from 'node:async_hooks';
import { type SqlAdapterOptions, SqlStorageAdapter } from './sql';

export interface BunSqliteDatabase {
  query(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number };
  };
  transaction<T>(fn: () => T): () => T;
  close?(): void;
}
export class BunSqliteAdapter<
  E extends Record<string, any>,
  ID extends string | number = string,
> extends SqlStorageAdapter<E, ID> {
  private readonly txStorage = new AsyncLocalStorage<boolean>();
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: BunSqliteDatabase,
    options: SqlAdapterOptions<E>,
  ) {
    super(options);
  }
  protected async allRows(sql: string, args: unknown[] = []) {
    return this.db.query(sql).all(...args) as Record<string, unknown>[];
  }
  protected async firstRow(sql: string, args: unknown[] = []) {
    return (this.db.query(sql).get(...args) as Record<string, unknown> | null) ?? null;
  }
  protected async run(sql: string, args: unknown[] = []) {
    return this.db.query(sql).run(...args);
  }
  async transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T> {
    if (this.txStorage.getStore()) {
      return fn(this);
    }
    const runTx = async () => {
      this.db.query('BEGIN IMMEDIATE').run();
      try {
        const result = await this.txStorage.run(true, () => fn(this));
        this.db.query('COMMIT').run();
        return result;
      } catch (err) {
        try {
          this.db.query('ROLLBACK').run();
        } catch {}
        throw err;
      }
    };
    const nextTx = this.txChain.then(runTx, runTx);
    this.txChain = nextTx.catch(() => {});
    return nextTx as Promise<T>;
  }
  dispose(): void {
    this.db.close?.();
  }
}
