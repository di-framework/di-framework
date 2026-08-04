import type { StorageAdapter } from '../adapter';

type Row = Record<string, unknown>;
export interface SqlMapping<E> {
  idColumn?: string;
  entityToRow?: (entity: E) => Row;
  rowToEntity?: (row: Row) => E;
}
export interface PaginationParams {
  page?: number;
  size?: number;
  sort?: string | string[];
  filter?: Record<string, unknown>;
  withDeleted?: boolean;
}

const ident = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
};
const op = (value: unknown): [string, unknown[]] => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) throw new Error('Filter operator must contain one entry');
    const [key, v] = entries[0]!;
    const operators: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE' };
    if (!(key in operators)) throw new Error(`Unsupported filter operator: ${key}`);
    return [`${operators[key]} ?`, [v]];
  }
  return ['= ?', [value]];
};

export function sqlWhere(filter: Record<string, unknown> = {}): { sql: string; args: unknown[] } {
  const clauses: string[] = []; const args: unknown[] = [];
  for (const [key, value] of Object.entries(filter)) { const [fragment, values] = op(value); clauses.push(`${ident(key)} ${fragment}`); args.push(...values); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

export interface SqlAdapterOptions<E> extends SqlMapping<E> { table: string; }

export abstract class SqlStorageAdapter<E extends Record<string, any>, ID extends string | number = string> implements StorageAdapter<E, ID> {
  protected readonly table: string; protected readonly idColumn: string;
  protected readonly toRow: (entity: E) => Row; protected readonly fromRow: (row: Row) => E;
  constructor(options: SqlAdapterOptions<E>) { this.table = ident(options.table); this.idColumn = ident(options.idColumn ?? 'id'); this.toRow = options.entityToRow ?? ((e) => ({ ...e })); this.fromRow = options.rowToEntity ?? ((r) => r as E); }
  protected abstract allRows(sql: string, args?: unknown[]): Promise<Row[]>;
  protected abstract firstRow(sql: string, args?: unknown[]): Promise<Row | null>;
  protected abstract run(sql: string, args?: unknown[]): Promise<{ changes?: number }>;
  async findById(id: ID): Promise<E | null> { const row = await this.firstRow(`SELECT * FROM ${this.table} WHERE ${this.idColumn} = ? LIMIT 1`, [id]); return row ? this.fromRow(row) : null; }
  async findMany(ids: ID[]): Promise<E[]> { if (!ids.length) return []; const marks = ids.map(() => '?').join(','); const rows = await this.allRows(`SELECT * FROM ${this.table} WHERE ${this.idColumn} IN (${marks})`, ids); return rows.map((r) => this.fromRow(r)); }
  async findAll(): Promise<E[]> { return (await this.allRows(`SELECT * FROM ${this.table}`)).map((r) => this.fromRow(r)); }
  async save(entity: E): Promise<E> { const row = this.toRow(entity); const keys = Object.keys(row); if (!keys.length) throw new Error('Cannot save an empty entity'); const cols = keys.map(ident).join(','); const marks = keys.map(() => '?').join(','); const updates = keys.filter((k) => ident(k) !== this.idColumn).map((k) => `${ident(k)} = excluded.${ident(k)}`).join(','); const sql = `INSERT INTO ${this.table} (${cols}) VALUES (${marks}) ON CONFLICT (${this.idColumn}) DO UPDATE SET ${updates || `${this.idColumn}=excluded.${this.idColumn}`}`; await this.run(sql, keys.map((k) => row[k])); return entity; }
  async delete(id: ID): Promise<boolean> { const result = await this.run(`DELETE FROM ${this.table} WHERE ${this.idColumn} = ?`, [id]); return (result.changes ?? 0) > 0; }
  async count(filter: Record<string, unknown> = {}): Promise<number> { const w = sqlWhere(filter); const row = await this.firstRow(`SELECT COUNT(*) as count FROM ${this.table}${w.sql}`, w.args); return Number(row?.count ?? 0); }
  async exists(id: ID): Promise<boolean> { return (await this.count({ [this.idColumn.slice(1, -1)]: id })) > 0; }
  async findPaginated(params: PaginationParams = {}) { const page = Math.max(1, params.page ?? 1); const size = Math.max(1, params.size ?? 10); const w = sqlWhere(params.filter); const order = (Array.isArray(params.sort) ? params.sort : params.sort ? [params.sort] : []).map((s) => { const [k, direction = 'asc'] = s.split(':'); return `${ident(k!)} ${direction.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`; }).join(', '); const total = await this.count(params.filter); const rows = await this.allRows(`SELECT * FROM ${this.table}${w.sql}${order ? ` ORDER BY ${order}` : ''} LIMIT ? OFFSET ?`, [...w.args, size, (page - 1) * size]); return { items: rows.map((r) => this.fromRow(r)), total, page, size, pages: Math.ceil(total / size) }; }
  abstract transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T>;
}
