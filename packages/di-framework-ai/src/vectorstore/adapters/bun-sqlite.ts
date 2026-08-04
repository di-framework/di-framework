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
interface WasmSimilarity {
  cosine_similarity_dataspace(
    dataspace: Float64Array,
    rows: number,
    dimensions: number,
    query: Float64Array,
  ): ArrayLike<number>;
}
interface VectorRow {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly embedding: number[];
}
interface ScoredRow {
  readonly r: VectorRow;
  readonly score: number;
}
const WASM_SIMILARITY_SPECIFIER = 'wasm-similarity';
let wasmPromise: Promise<WasmSimilarity | null> | undefined;
function loadWasm(): Promise<WasmSimilarity | null> {
  wasmPromise ??= import(WASM_SIMILARITY_SPECIFIER)
    .then((module: unknown) =>
      typeof (module as WasmSimilarity | null)?.cosine_similarity_dataspace === 'function'
        ? (module as WasmSimilarity)
        : null,
    )
    .catch(() => null);
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
    const ranked = (await this.score(query, candidates)).sort((a, b) => b.score - a.score);
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
  private async score(query: number[], candidates: readonly VectorRow[]): Promise<ScoredRow[]> {
    const wasm = candidates.length > 0 ? await loadWasm() : null;
    if (!wasm) return candidates.map((r) => ({ r, score: cosine(query, r.embedding) }));
    const pairs = wasm.cosine_similarity_dataspace(
      new Float64Array(candidates.flatMap((r) => r.embedding)),
      candidates.length,
      query.length,
      new Float64Array(query),
    );
    const scored: ScoredRow[] = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const candidate = candidates[pairs[i + 1] as number];
      if (candidate) scored.push({ r: candidate, score: pairs[i] as number });
    }
    return scored;
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
