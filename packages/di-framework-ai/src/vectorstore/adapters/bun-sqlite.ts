import type { Document } from '../../document/document.ts';
import { withDocumentScore } from '../../document/document.ts';
import type { EmbeddingModel } from '../../embedding/embedding-model.ts';
import { evaluateFilterExpression, type FilterExpression } from '../filter/index.ts';
import { type SearchRequest, searchRequest } from '../search-request.ts';
import type { VectorStore } from '../vector-store.ts';
export interface BunVectorDatabase {
  run(sql: string, ...args: unknown[]): { changes?: number };
  query(sql: string): { all(...args: unknown[]): unknown[] };
}
export interface BunSqliteVectorStoreOptions {
  db: BunVectorDatabase;
  embeddingModel: EmbeddingModel;
  table?: string;
  name?: string;
}
const cosine = (a: number[], b: number[]) => {
  if (a.length !== b.length)
    throw new Error(`Embedding dimension mismatch: ${a.length} != ${b.length}`);
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x ** 2;
    bb += y ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
};
type WasmSimilarity = typeof import('wasm-similarity');
let wasmPromise: Promise<WasmSimilarity | null> | undefined;
function loadWasm(): Promise<WasmSimilarity | null> {
  wasmPromise ??= import('wasm-similarity').catch(() => null);
  return wasmPromise;
}
export class BunSqliteVectorStore implements VectorStore {
  readonly name: string;
  private readonly table: string;
  private readonly model: EmbeddingModel;
  private readonly db: BunVectorDatabase;
  constructor(options: BunSqliteVectorStoreOptions) {
    this.db = options.db;
    this.model = options.embeddingModel;
    this.table = options.table ?? 'ai_vectors';
    this.name = options.name ?? 'BunSqliteVectorStore';
    this.db.run(
      `CREATE TABLE IF NOT EXISTS "${this.table}" (id TEXT PRIMARY KEY, text TEXT NOT NULL, metadata TEXT NOT NULL, embedding TEXT NOT NULL)`,
    );
  }
  async add(documents: readonly Document[]): Promise<void> {
    for (const doc of documents) {
      const vector = await this.model.embedDocument(doc);
      if (this.model.dimensions && vector.length !== this.model.dimensions)
        throw new Error('Embedding dimension mismatch');
      this.db.run(
        `INSERT INTO "${this.table}" (id,text,metadata,embedding) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, metadata=excluded.metadata, embedding=excluded.embedding`,
        doc.id,
        doc.text ?? '',
        JSON.stringify(doc.metadata),
        JSON.stringify(vector),
      );
    }
  }
  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.db.run(`DELETE FROM "${this.table}" WHERE id = ?`, id);
  }
  async deleteByFilter(filter: FilterExpression): Promise<void> {
    const rows = this.rows().filter((r) => evaluateFilterExpression(filter, r.metadata));
    await this.delete(rows.map((r) => r.id));
  }
  async similaritySearch(request: SearchRequest): Promise<readonly Document[]> {
    const query = await this.model.embed(request.query);
    const candidates = this.rows().filter(
      (r) =>
        !request.filterExpression || evaluateFilterExpression(request.filterExpression, r.metadata),
    );
    const wasm = await loadWasm();
    const ranked =
      wasm && candidates.length > 0
        ? wasm
            .cosine_similarity_dataspace(
              new Float64Array(candidates.flatMap((r) => r.embedding)),
              candidates.length,
              query.length,
              new Float64Array(query),
            )
            .reduce<Array<{ r: (typeof candidates)[number]; score: number }>>(
              (out, value, i, values) => {
                if (i % 2 === 0 && i + 1 < values.length)
                  out.push({ r: candidates[values[i + 1]!]!, score: value });
                return out;
              },
              [],
            )
        : candidates
            .map((r) => ({ r, score: cosine(query, r.embedding) }))
            .sort((a, b) => b.score - a.score);
    return ranked
      .filter((x) => x.score >= request.similarityThreshold)
      .slice(0, request.topK)
      .map(({ r, score }) =>
        withDocumentScore(
          { id: r.id, text: r.text, media: null, metadata: r.metadata, score: null },
          score,
        ),
      );
  }
  similaritySearchQuery(query: string) {
    return this.similaritySearch(searchRequest({ query }));
  }
  private rows() {
    return this.db
      .query(`SELECT id,text,metadata,embedding FROM "${this.table}"`)
      .all()
      .map((x) => {
        const r = x as any;
        return {
          id: String(r.id),
          text: String(r.text),
          metadata: JSON.parse(String(r.metadata)),
          embedding: JSON.parse(String(r.embedding)) as number[],
        };
      });
  }
}
