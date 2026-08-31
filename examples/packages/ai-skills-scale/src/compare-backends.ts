import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { BunSqliteVectorStore, PrecomputedEmbeddingModel } from '@di-framework/ai';
import {
  InMemorySkillVectorSearch,
  type SkillIndexWriteRequest,
  SkillSearchConnection,
  SkillSearchIndexer,
  SkillSearchRepository,
  type SkillsIndex,
  type SkillVectorSearch,
  toSkillIndexWriteRequest,
} from '@di-framework/ai-utils';

export function syntheticSkillWriteRequest(options: {
  count: number;
  dimensions?: number;
  seed?: number;
}): SkillIndexWriteRequest {
  const count = options.count;
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const dimensions = options.dimensions ?? 32;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('dimensions must be a positive integer');
  }
  const rng = mulberry32(options.seed ?? 1);
  const vectors = Array.from({ length: count }, (_, index) => ({
    name: `skill-${index}`,
    description: `Synthetic skill ${index}`,
    chunk: 0,
    source: 'document' as const,
    embedding: randomUnit(dimensions, rng),
  }));
  return {
    metadata: {
      indexVersion: `synthetic:${count}`,
      catalogVersion: `synthetic:${count}`,
      dimensions,
      scoring: 'cosine',
    },
    vectors,
  };
}

export function recallAtK(
  exactIds: readonly string[],
  candidateIds: readonly string[],
  k: number,
): number {
  const truth = new Set(exactIds.slice(0, k));
  if (truth.size === 0) return 1;
  return candidateIds.slice(0, k).filter((id) => truth.has(id)).length / truth.size;
}

export function chunkHitId(match: { name: string; chunk: number }): string {
  return `${match.name}\0${match.chunk}`;
}

export async function compareSkillSearchRecall(options: {
  exact: SkillVectorSearch;
  candidate: SkillVectorSearch;
  queries: readonly ArrayLike<number>[];
  k?: number;
  namespace?: string;
}): Promise<{ recallAtK: number; exactSearchMs: number; candidateSearchMs: number }> {
  const k = options.k ?? 10;
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (options.queries.length === 0) throw new Error('At least one query is required');
  let recall = 0;
  let exactSearchMs = 0;
  let candidateSearchMs = 0;
  for (const query of options.queries) {
    const exactStarted = performance.now();
    const exact = await options.exact.query(query, { limit: k, namespace: options.namespace });
    exactSearchMs += performance.now() - exactStarted;
    const candidateStarted = performance.now();
    const candidate = await options.candidate.query(query, {
      limit: k,
      namespace: options.namespace,
    });
    candidateSearchMs += performance.now() - candidateStarted;
    recall += recallAtK(exact.map(chunkHitId), candidate.map(chunkHitId), k);
  }
  return {
    recallAtK: recall / options.queries.length,
    exactSearchMs,
    candidateSearchMs,
  };
}

export async function indexSkillsWithConnection(
  request: SkillIndexWriteRequest,
  connection: SkillSearchConnection,
): Promise<{ writtenVectors: number; elapsedMs: number }> {
  const started = performance.now();
  const receipt = await new SkillSearchIndexer(request, connection).replace();
  return { writtenVectors: receipt.writtenVectors, elapsedMs: performance.now() - started };
}

export function writeRequestFromSkillsIndex(index: SkillsIndex): SkillIndexWriteRequest {
  return toSkillIndexWriteRequest(index);
}

export function openSqliteSkillConnection(
  path: string,
  options: {
    dimensions: number;
    searchMode?: 'auto' | 'exact' | 'ann';
    exactScanLimit?: number;
  } = {
    dimensions: 32,
  },
): SkillSearchConnection {
  return SkillSearchConnection.fromVectorStore(
    new BunSqliteVectorStore({
      db: new Database(path),
      embeddingModel: new PrecomputedEmbeddingModel(options.dimensions),
      searchMode: options.searchMode ?? 'auto',
      exactScanLimit: options.exactScanLimit,
    }),
  );
}

export function sqliteSkillSearch(connection: SkillSearchConnection): SkillVectorSearch {
  return new SkillSearchRepository(connection);
}

export interface AnnCompareReport {
  readonly recallAt10VsExact: number;
  readonly exactSearchMs: number;
  readonly annSearchMs: number;
  readonly indexBuildMs: number;
  readonly artifactBytes: number;
  readonly peakMemoryBytes: number;
  readonly skillCount: number;
}

export async function runAnnCompare(options: {
  writeRequest: SkillIndexWriteRequest;
  sqlitePath: string;
  queries: readonly ArrayLike<number>[];
  exactScanLimit?: number;
  searchMode?: 'auto' | 'exact' | 'ann';
  k?: number;
  memoryUsage?: () => number;
}): Promise<AnnCompareReport> {
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage.rss());
  let peakMemoryBytes = memoryUsage();
  const exact = new InMemorySkillVectorSearch();
  await exact.replace(options.writeRequest);
  const connection = openSqliteSkillConnection(options.sqlitePath, {
    dimensions: options.writeRequest.metadata.dimensions,
    searchMode: options.searchMode ?? 'ann',
    exactScanLimit: options.exactScanLimit,
  });
  const indexed = await indexSkillsWithConnection(options.writeRequest, connection);
  peakMemoryBytes = Math.max(peakMemoryBytes, memoryUsage());
  const comparison = await compareSkillSearchRecall({
    exact,
    candidate: sqliteSkillSearch(connection),
    queries: options.queries,
    k: options.k ?? 10,
  });
  peakMemoryBytes = Math.max(peakMemoryBytes, memoryUsage());
  return {
    recallAt10VsExact: comparison.recallAtK,
    exactSearchMs: comparison.exactSearchMs,
    annSearchMs: comparison.candidateSearchMs,
    indexBuildMs: indexed.elapsedMs,
    artifactBytes: statSync(options.sqlitePath).size,
    peakMemoryBytes,
    skillCount: new Set(options.writeRequest.vectors.map((vector) => vector.name)).size,
  };
}

export function formatAnnCompareMarkdown(report: AnnCompareReport): string {
  return [
    '# ANN vs exact skill search',
    '',
    `- Skills: ${report.skillCount}`,
    `- Recall@10 vs exact: ${report.recallAt10VsExact.toFixed(4)}`,
    `- Exact search: ${report.exactSearchMs.toFixed(2)} ms`,
    `- ANN search: ${report.annSearchMs.toFixed(2)} ms`,
    `- Index build: ${report.indexBuildMs.toFixed(2)} ms`,
    `- Artifact bytes: ${report.artifactBytes}`,
    `- Peak RSS bytes: ${report.peakMemoryBytes}`,
    '',
  ].join('\n');
}

function randomUnit(dimensions: number, rng: () => number): number[] {
  const values = Array.from({ length: dimensions }, () => rng() * 2 - 1);
  let norm = 0;
  for (const value of values) norm += value * value;
  const scale = 1 / Math.sqrt(Math.max(norm, 1e-12));
  return values.map((value) => value * scale);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
