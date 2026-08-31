import { describe, expect, test } from 'bun:test';
import { chatClientRequest, Prompt } from '@di-framework/ai';
import type { SkillEmbedder } from '../src/index.ts';
import {
  agentSkill,
  aggregateSkillChunkMatches,
  buildSkillsIndex,
  InMemorySkillCatalogStore,
  InMemorySkillVectorSearch,
  LocalSkillCatalogStore,
  LocalSkillIndexWriter,
  LocalSkillVectorSearch,
  SkillAdapterError,
  SkillsIndex,
  SkillsRetrievalAdvisor,
  skillsTool,
} from '../src/index.ts';

describe('platform-neutral skill adapters', () => {
  test('catalog isolates namespaces and validates activation versions', async () => {
    const alpha = agentSkill({ name: 'review', description: 'Alpha review', content: 'alpha' });
    const beta = agentSkill({ name: 'review', description: 'Beta review', content: 'beta' });
    const store = new InMemorySkillCatalogStore(
      [
        {
          descriptor: { name: 'review', sourceHash: 'a', version: '1', namespace: 'a' },
          skill: alpha,
        },
        {
          descriptor: { name: 'review', sourceHash: 'b', version: '2', namespace: 'b' },
          skill: beta,
        },
      ],
      { a: 'catalog-a', b: 'catalog-b' },
    );

    expect(await store.list({ namespace: 'a' })).toEqual([
      { name: 'review', sourceHash: 'a', version: '1', namespace: 'a' },
    ]);
    expect((await store.load('review', { namespace: 'b', expectedVersion: '2' }))?.content).toBe(
      'beta',
    );
    await expect(
      store.load('review', { namespace: 'b', expectedVersion: 'old' }),
    ).rejects.toMatchObject({ code: 'STALE_CATALOG' });
    expect(await store.version({ namespace: 'a' })).toBe('catalog-a');
    expect(await store.health({ namespace: 'b' })).toMatchObject({
      status: 'ready',
      checkedVersion: 'catalog-b',
    });
    expect(
      await new InMemorySkillCatalogStore([
        { descriptor: { name: 'review', sourceHash: 'generated' }, skill: alpha },
      ]).version(),
    ).toMatch(/^fnv1a32:/);
  });

  test('exact search enforces ready catalog and model metadata', async () => {
    const search = new InMemorySkillVectorSearch();
    const receipt = await search.replace({
      metadata: {
        indexVersion: 'index-1',
        catalogVersion: 'catalog-1',
        dimensions: 2,
        model: 'model',
        revision: 'revision',
        embedderId: 'model@revision',
        scoring: 'cosine',
      },
      vectors: [
        {
          name: 'beta',
          description: 'Beta',
          chunk: 0,
          source: 'document',
          embedding: [1, 0],
        },
        {
          name: 'alpha',
          description: 'Alpha',
          chunk: 0,
          source: 'document',
          embedding: [1, 0],
        },
      ],
    });

    expect(receipt).toMatchObject({ ready: true, writtenVectors: 2 });
    expect(await search.metadata()).toMatchObject({ indexVersion: 'index-1' });
    expect(await search.health()).toMatchObject({ status: 'ready' });
    expect(
      await search.query([1, 0], {
        limit: 1,
        catalogVersion: 'catalog-1',
        model: 'model',
      }),
    ).toEqual([
      {
        name: 'alpha',
        description: 'Alpha',
        score: 1,
        chunk: 0,
        source: 'document',
      },
    ]);
    await expect(search.query([1, 0], { catalogVersion: 'stale' })).rejects.toMatchObject({
      code: 'STALE_CATALOG',
    });
    await expect(search.query([1, 0], { model: 'other' })).rejects.toMatchObject({
      code: 'MODEL_MISMATCH',
    });
    expect(new SkillAdapterError('TIMEOUT', 'late')).toMatchObject({
      name: 'SkillAdapterError',
      code: 'TIMEOUT',
    });
    await search.upsert?.({
      metadata: {
        indexVersion: 'index-2',
        catalogVersion: 'catalog-1',
        dimensions: 2,
        model: 'model',
        revision: 'revision',
        embedderId: 'model@revision',
        scoring: 'cosine',
      },
      vectors: [
        {
          name: 'gamma',
          description: 'Gamma',
          chunk: 0,
          source: 'document',
          embedding: [0, 1],
        },
      ],
    });
    expect((await search.query([0, 1], { limit: 1 }))[0]?.name).toBe('gamma');
    expect(await new InMemorySkillVectorSearch().health()).toMatchObject({ status: 'not-ready' });
    const initialized = new InMemorySkillVectorSearch([
      {
        metadata: {
          indexVersion: 'array-index',
          catalogVersion: 'array-catalog',
          dimensions: 1,
          scoring: 'cosine',
        },
        vectors: [],
      },
    ]);
    expect(await initialized.metadata()).toMatchObject({ indexVersion: 'array-index' });
  });
});

describe('local adapters', () => {
  const embedder: SkillEmbedder = {
    id: 'local@test',
    model: 'local',
    revision: 'test',
    async embed(texts) {
      return texts.map((text) =>
        text.includes('alpha') ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
      );
    },
    async split(text) {
      return [text];
    },
  };

  test('filesystem-compatible catalog and JSONL search implement the contracts', async () => {
    const skills = [
      agentSkill({ name: 'alpha', description: 'alpha routing', content: 'alpha body' }),
      agentSkill({ name: 'beta', description: 'beta routing', content: 'beta body' }),
    ];
    const catalog = new LocalSkillCatalogStore(skills);
    const outputFile = `${process.env.TMPDIR ?? '/tmp'}/local-adapter-${crypto.randomUUID()}.jsonl`;
    await buildSkillsIndex({ skills, outputFile, threshold: 1, embedder });
    const search = new LocalSkillVectorSearch(outputFile);

    expect((await catalog.list()).map(({ name }) => name)).toEqual(['alpha', 'beta']);
    expect((await catalog.load('alpha'))?.content).toBe('alpha body');
    expect(await catalog.load('missing')).toBeUndefined();
    expect(await catalog.version()).toBeTruthy();
    expect(await catalog.health()).toMatchObject({ status: 'ready' });
    await expect(catalog.load('alpha', { expectedVersion: 'stale' })).rejects.toMatchObject({
      code: 'STALE_CATALOG',
    });
    await expect(catalog.list({ namespace: 'remote' })).rejects.toThrow(/does not support/);
    expect((await search.query([1, 0], { limit: 1 }))[0]).toMatchObject({
      name: 'alpha',
      chunk: 0,
      score: 1,
    });
    expect(await search.health()).toMatchObject({ status: 'ready' });
  });

  test('index builders can write to a replacement adapter and return readiness', async () => {
    const writer = new InMemorySkillVectorSearch();
    const skills = [
      agentSkill({ name: 'alpha', description: 'Alpha tasks', content: 'alpha' }),
      agentSkill({ name: 'beta', description: 'Beta tasks', content: 'beta' }),
    ];
    const result = await SkillsIndex.builder()
      .addSkills(skills)
      .threshold(1)
      .embedder(embedder)
      .writer(writer)
      .build();

    expect(result.receipt).toMatchObject({ ready: true, writtenVectors: 2 });
    expect((await writer.query([0, 1], { limit: 1 }))[0]?.name).toBe('beta');
  });

  test('local writer groups chunks and object-backed search reports metadata', async () => {
    const outputFile = `${process.env.TMPDIR ?? '/tmp'}/local-writer-${crypto.randomUUID()}.jsonl`;
    const writer = new LocalSkillIndexWriter(outputFile);
    await writer.replace({
      metadata: {
        indexVersion: 'local-write',
        catalogVersion: 'catalog-write',
        dimensions: 2,
        model: 'local',
        revision: 'test',
        embedderId: 'local@test',
        scoring: 'cosine',
      },
      vectors: [
        {
          name: 'alpha',
          description: 'Alpha',
          documentHash: 'hash',
          chunk: 0,
          source: 'document',
          embedding: [1, 0],
        },
        {
          name: 'alpha',
          description: 'Alpha',
          documentHash: 'hash',
          chunk: 1,
          source: 'document',
          embedding: [0, 1],
        },
      ],
    });
    const loaded = new LocalSkillVectorSearch(outputFile).index;
    const search = new LocalSkillVectorSearch(loaded);
    expect(loaded.entries[0]?.chunks).toHaveLength(2);
    expect(await search.metadata()).toMatchObject({ catalogVersion: 'catalog-write', ready: true });
  });

  test('adapter retrieval shares aggregation and rejects partial backend results', async () => {
    const skills = [
      agentSkill({ name: 'alpha', description: 'Alpha tasks', content: 'alpha' }),
      agentSkill({ name: 'beta', description: 'Beta tasks', content: 'beta' }),
    ];
    const catalog = new InMemorySkillCatalogStore(
      skills.map((skill) => ({
        descriptor: {
          name: skill.name,
          description: skill.description,
          sourceHash: skill.name,
        },
        skill,
      })),
      { '': 'catalog' },
    );
    const vector = new InMemorySkillVectorSearch({
      metadata: {
        indexVersion: 'adapter',
        catalogVersion: 'catalog',
        dimensions: 2,
        model: embedder.model,
        revision: embedder.revision,
        embedderId: embedder.id,
        scoring: 'cosine',
      },
      vectors: [
        {
          name: 'alpha',
          description: 'Alpha tasks',
          chunk: 0,
          source: 'document',
          embedding: [1, 0],
        },
        {
          name: 'alpha',
          description: 'Alpha tasks',
          chunk: 1,
          source: 'document',
          embedding: [0, 1],
        },
        {
          name: 'beta',
          description: 'Beta tasks',
          chunk: 0,
          source: 'document',
          embedding: [0, 1],
        },
      ],
    });
    const advisor = new SkillsRetrievalAdvisor({
      skills,
      catalogStore: catalog,
      vectorSearch: vector,
      embedder,
      limit: 1,
    });
    const selected = await advisor.before(
      chatClientRequest(new Prompt('alpha request', { toolCallbacks: [skillsTool({ skills })] })),
    );
    expect(selected.context.get('skills_retrieval')).toEqual([
      expect.objectContaining({ name: 'alpha' }),
    ]);
    expect(
      aggregateSkillChunkMatches(
        [
          {
            name: 'alpha',
            description: 'Alpha',
            score: 0.4,
            chunk: 1,
            source: 'document',
          },
        ],
        1,
      )[0],
    ).toMatchObject({ score: 0.4, matchedChunk: 1 });
    expect(() =>
      aggregateSkillChunkMatches(
        [
          {
            name: 'unknown',
            description: 'Unknown',
            score: Number.NaN,
            chunk: -1,
            source: 'document',
          },
        ],
        1,
        new Map(skills.map((skill) => [skill.name, skill])),
      ),
    ).toThrow(/invalid chunk/);
    expect(() =>
      aggregateSkillChunkMatches(
        [
          {
            name: 'unknown',
            description: 'Unknown',
            score: 1,
            chunk: 0,
            source: 'document',
          },
        ],
        1,
        new Map(skills.map((skill) => [skill.name, skill])),
      ),
    ).toThrow(/unknown skill/);
  });
});
