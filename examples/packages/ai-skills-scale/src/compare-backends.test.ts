import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BunSqliteVectorStore,
  PrecomputedEmbeddingModel,
  SimpleVectorStore,
} from '@di-framework/ai';
import {
  InMemorySkillVectorSearch,
  SkillSearchConnection,
  SkillSearchIndexer,
  SkillSearchRepository,
} from '@di-framework/ai-utils';
import {
  chunkHitId,
  compareSkillSearchRecall,
  formatAnnCompareMarkdown,
  indexSkillsWithConnection,
  openSqliteSkillConnection,
  recallAtK,
  runAnnCompare,
  sqliteSkillSearch,
  syntheticSkillWriteRequest,
  writeRequestFromSkillsIndex,
} from './compare-backends.ts';

describe('ANN vs exact skill search compare helpers', () => {
  test('synthetic catalogs meet 99% recall@10 against exact cosine', async () => {
    const request = syntheticSkillWriteRequest({ count: 200, dimensions: 16, seed: 7 });
    const exact = new InMemorySkillVectorSearch();
    await exact.replace(request);
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'skill-ann-')), 'skills.sqlite');
    const connection = openSqliteSkillConnection(sqlitePath, {
      dimensions: 16,
      searchMode: 'ann',
      exactScanLimit: 32,
    });
    const indexed = await indexSkillsWithConnection(request, connection);
    expect(indexed.writtenVectors).toBe(200);
    expect(statSync(sqlitePath).size).toBeGreaterThan(0);
    const queries = request.vectors.slice(0, 20).map((vector) => vector.embedding);
    const comparison = await compareSkillSearchRecall({
      exact,
      candidate: sqliteSkillSearch(connection),
      queries,
      k: 10,
    });
    expect(comparison.recallAtK).toBeGreaterThanOrEqual(0.99);
    expect(comparison.candidateSearchMs).toBeGreaterThanOrEqual(0);
    expect(recallAtK(['a', 'b'], ['a', 'c'], 2)).toBe(0.5);
    expect(recallAtK([], ['a'], 10)).toBe(1);
    expect(chunkHitId({ name: 'a', chunk: 1 })).toBe('a\0' + '1');
  });

  test('validates inputs and can index through an in-memory vector store', async () => {
    expect(() => syntheticSkillWriteRequest({ count: 0 })).toThrow(/positive integer/);
    expect(() => syntheticSkillWriteRequest({ count: 1, dimensions: 0 })).toThrow(
      /positive integer/,
    );
    const request = syntheticSkillWriteRequest({ count: 3, dimensions: 2, seed: 1 });
    const connection = SkillSearchConnection.fromVectorStore(
      SimpleVectorStore.of(new PrecomputedEmbeddingModel(2)),
    );
    await new SkillSearchIndexer(request, connection).replace();
    await expect(
      compareSkillSearchRecall({
        exact: new SkillSearchRepository(connection),
        candidate: new SkillSearchRepository(connection),
        queries: [],
      }),
    ).rejects.toThrow(/At least one query/);
    await expect(
      compareSkillSearchRecall({
        exact: new SkillSearchRepository(connection),
        candidate: new SkillSearchRepository(connection),
        queries: [[1, 0]],
        k: 0,
      }),
    ).rejects.toThrow(/positive integer/);
    const comparison = await compareSkillSearchRecall({
      exact: new SkillSearchRepository(connection),
      candidate: new SkillSearchRepository(connection),
      queries: [[1, 0]],
      k: 1,
    });
    expect(comparison.recallAtK).toBe(1);
    expect(
      writeRequestFromSkillsIndex({
        metadata: {
          kind: '@di-framework/ai-utils/skills-index',
          version: 3,
          indexed: true,
          skillCount: 1,
          chunkCount: 1,
          threshold: 0,
          retrievalLimit: 10,
          chunkTokens: 256,
          chunkOverlapTokens: 32,
          scoring: 'hybrid-rrf-bm25-v1',
          vectorEncoding: 'int8-per-vector-v1',
          catalogHash: 'hash',
          dimensions: 2,
        },
        entries: [
          {
            kind: 'skill',
            name: 'alpha',
            description: 'Alpha',
            documentHash: 'hash',
            chunks: [{ source: 'document', embedding: new Float32Array([1, 0]) }],
          },
        ],
      }).vectors[0]?.name,
    ).toBe('alpha');
    expect(new Database(':memory:')).toBeDefined();
    expect(
      new BunSqliteVectorStore({
        db: new Database(':memory:'),
        embeddingModel: new PrecomputedEmbeddingModel(2),
      }).name,
    ).toBe('BunSqliteVectorStore');
  });

  test('runAnnCompare records recall, latency, disk, and memory', async () => {
    const request = syntheticSkillWriteRequest({ count: 40, dimensions: 8, seed: 3 });
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'skill-ann-report-')), 'skills.sqlite');
    const report = await runAnnCompare({
      writeRequest: request,
      sqlitePath,
      queries: request.vectors.slice(0, 8).map((vector) => vector.embedding),
      searchMode: 'ann',
      k: 5,
      memoryUsage: () => 1024,
    });
    expect(report.skillCount).toBe(40);
    expect(report.recallAt10VsExact).toBeGreaterThanOrEqual(0.99);
    expect(report.artifactBytes).toBeGreaterThan(0);
    expect(report.peakMemoryBytes).toBe(1024);
    expect(formatAnnCompareMarkdown(report)).toContain('Recall@10 vs exact');
  });
});
