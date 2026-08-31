import { describe, expect, test } from 'bun:test';
import {
  agentSkill,
  InMemorySkillCatalogStore,
  InMemorySkillVectorSearch,
  SkillAdapterError,
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
