import { AsyncLocalStorage } from 'node:async_hooks';
import { type SqlAdapterOptions, SqlStorageAdapter } from './sql';
export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
}
export interface D1Prepared {
  bind(...args: unknown[]): D1Prepared;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number }; success?: boolean }>;
}
export interface D1Database {
  prepare(sql: string): D1Prepared;
  batch?(statements: D1Prepared[]): Promise<unknown[]>;
}
export class D1Adapter<
  E extends Record<string, any>,
  ID extends string | number = string,
> extends SqlStorageAdapter<E, ID> {
  private readonly txStorage = new AsyncLocalStorage<boolean>();
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: D1Database,
    options: SqlAdapterOptions<E>,
  ) {
    super(options);
  }
  protected async allRows(sql: string, args: unknown[] = []) {
    const r = await this.db
      .prepare(sql)
      .bind(...args)
      .all<Record<string, unknown>>();
    return r.results ?? [];
  }
  protected async firstRow(sql: string, args: unknown[] = []) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .first<Record<string, unknown>>();
  }
  protected async run(sql: string, args: unknown[] = []) {
    const r = await this.db
      .prepare(sql)
      .bind(...args)
      .run();
    return { changes: r.meta?.changes };
  }
  async transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T> {
    if (this.txStorage.getStore()) {
      return fn(this);
    }
    const runTx = async () => {
      await this.db.prepare('BEGIN IMMEDIATE').run();
      try {
        const result = await this.txStorage.run(true, () => fn(this));
        await this.db.prepare('COMMIT').run();
        return result;
      } catch (err) {
        try {
          await this.db.prepare('ROLLBACK').run();
        } catch {}
        throw err;
      }
    };
    const nextTx = this.txChain.then(runTx, runTx);
    this.txChain = nextTx.catch(() => {});
    return nextTx as Promise<T>;
  }
}
