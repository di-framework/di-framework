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
  private inTx = false;
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
    if (this.inTx) {
      return fn(this);
    }
    const runTx = async () => {
      this.inTx = true;
      this.db.query('BEGIN IMMEDIATE').run();
      try {
        const result = await fn(this);
        this.db.query('COMMIT').run();
        return result;
      } catch (err) {
        try {
          this.db.query('ROLLBACK').run();
        } catch {}
        throw err;
      } finally {
        this.inTx = false;
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
