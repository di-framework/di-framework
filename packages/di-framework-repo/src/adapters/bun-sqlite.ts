import { SqlStorageAdapter, type SqlAdapterOptions } from './sql';

export interface BunSqliteDatabase { query(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): { changes?: number } }; transaction<T>(fn: () => T): () => T; close?(): void; }
export class BunSqliteAdapter<E extends Record<string, any>, ID extends string | number = string> extends SqlStorageAdapter<E, ID> {
  constructor(private readonly db: BunSqliteDatabase, options: SqlAdapterOptions<E>) { super(options); }
  protected async allRows(sql: string, args: unknown[] = []) { return this.db.query(sql).all(...args) as Record<string, unknown>[]; }
  protected async firstRow(sql: string, args: unknown[] = []) { return (this.db.query(sql).get(...args) as Record<string, unknown> | null) ?? null; }
  protected async run(sql: string, args: unknown[] = []) { return this.db.query(sql).run(...args); }
  async transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T> { return fn(this); }
  dispose(): void { this.db.close?.(); }
}
