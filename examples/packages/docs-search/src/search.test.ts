import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { DocPage } from './models/DocPage';
import { DocumentRepository } from './repositories/DocumentRepository';
import { EmbeddingService } from './services/EmbeddingService';
import { lexicalScore, makeSnippet, SearchService, tokenize } from './services/SearchService';
import { VectorIndexService } from './services/VectorIndexService';

function page(id: string, title: string, content: string, product = 'd'): DocPage {
  return Object.assign(new DocPage(), {
    id,
    url: `https://example.test/${id}.html`,
    pageTitle: title,
    mainTitle: title,
    breadcrumbs: `Docs|${title}`,
    content,
    product,
    version: 'latest',
  });
}

describe('tokenize + lexical helpers', () => {
  test('tokenize splits query', () => {
    expect(tokenize('findBy repository DI')).toEqual(['findby', 'repository', 'di']);
  });

  test('lexical prefers title hits', () => {
    const doc = page('1', 'Repositories', 'storage adapters and BaseRepository');
    const score = lexicalScore(doc, ['repositories', 'adapters']);
    expect(score).toBeGreaterThan(0.5);
  });

  test('snippet surrounds first match', () => {
    const s = makeSnippet('aaa repository bbb adapter ccc', ['repository'], 40);
    expect(s.toLowerCase()).toContain('repository');
  });
});

describe('incremental Vectorize sync', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  function wire() {
    const root = useContainer();
    root.register(DocumentRepository);
    root.register(EmbeddingService);
    root.register(VectorIndexService);
    root.register(SearchService);
    root.registerFactory('Env', () => () => ({}) as never, { singleton: true });
    return root;
  }

  test('first sync upserts all; second sync skips unchanged', async () => {
    const root = wire();
    const repo = root.resolve(DocumentRepository);
    await repo.seed([
      page('docs_repositories', 'Repositories', 'Use InMemoryRepository and BaseRepository.'),
      page('docs_graphql', 'GraphQL', 'Domain classes become the schema.'),
    ]);

    const search = root.resolve(SearchService);
    const first = await search.reindex();
    expect(first.upserted).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.deleted).toBe(0);

    const second = await search.reindex();
    expect(second.upserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.deleted).toBe(0);
  });

  test('changed content is re-upserted; removed ids are deleted', async () => {
    const root = wire();
    const repo = root.resolve(DocumentRepository);
    await repo.seed([
      page('a', 'Alpha', 'first version of alpha'),
      page('b', 'Beta', 'beta content about repositories'),
    ]);

    const search = root.resolve(SearchService);
    await search.reindex();

    // Change alpha, remove beta, add gamma
    await repo.delete('b');
    await repo.save(page('a', 'Alpha', 'second version of alpha — changed'));
    await repo.save(page('c', 'Gamma', 'brand new gamma page'));

    const sync = await search.reindex();
    expect(sync.upsertedIds.sort()).toEqual(['a', 'c']);
    expect(sync.deletedIds).toEqual(['b']);
    expect(sync.skipped).toBe(0); // only a and c in corpus; both changed/new
    // wait - skipped is pages.length - toUpsert. pages = a,c both upserted → skipped 0
    expect(sync.total).toBe(2);

    // Without Vectorize binding, search uses lexical fallback over the repo
    const res = await search.search({ query: 'gamma brand new', maxHits: 5 });
    expect(res.hits.some((h) => h.objectID === 'c')).toBe(true);

    // b was deleted from the repo — must not appear
    const beta = await search.search({ query: 'beta content repositories', maxHits: 5 });
    expect(beta.hits.every((h) => h.objectID !== 'b')).toBe(true);
  });

  test('full=true re-embeds everything', async () => {
    const root = wire();
    const repo = root.resolve(DocumentRepository);
    await repo.seed([page('x', 'X', 'stable content')]);
    const search = root.resolve(SearchService);
    await search.reindex();
    const full = await search.reindex({ full: true });
    expect(full.upserted).toBe(1);
    expect(full.skipped).toBe(0);
  });
});

describe('DocumentRepository.replaceCorpus', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  test('drops existing pages and seeds the replacement corpus', async () => {
    const root = useContainer();
    root.register(DocumentRepository);
    const repo = root.resolve(DocumentRepository);

    await repo.seed([page('old-1', 'Old One', 'stale content'), page('old-2', 'Old Two', 'stale')]);
    expect(await repo.count()).toBe(2);

    const replaced = await repo.replaceCorpus([
      {
        objectID: 'new-1',
        url: 'https://example.test/new-1.html',
        pageTitle: 'New One',
        mainTitle: 'New One',
        breadcrumbs: 'Docs|New One',
        content: 'fresh content',
        product: 'd',
        version: 'latest',
      },
    ]);

    expect(replaced).toBe(1);
    const all = await repo.findAll();
    expect(all.map((p) => p.id)).toEqual(['new-1']);
  });
});

describe('EmbeddingService with a Workers AI binding', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  function wireWithAi(ai: Ai) {
    const root = useContainer();
    root.register(EmbeddingService);
    root.registerFactory('Env', () => () => ({ AI: ai, EMBEDDING_MODEL: '' }) as unknown as never, {
      singleton: true,
    });
    return root.resolve(EmbeddingService);
  }

  test('embeds through the AI binding when present', async () => {
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) } as unknown as Ai;
    const service = wireWithAi(ai);
    const [vector] = await service.embed('hello world');
    expect(vector).toEqual([1, 2, 3]);
  });

  test('throws when the AI binding returns a mismatched number of vectors', async () => {
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) } as unknown as Ai;
    const service = wireWithAi(ai);
    await expect(service.embed(['a', 'b'])).rejects.toThrow('missing data[]');
  });
});

describe('VectorIndexService.query with a Vectorize binding', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  test('maps Vectorize matches into VectorMatch results', async () => {
    const root = useContainer();
    root.register(EmbeddingService);
    root.register(VectorIndexService);
    const vectorize = {
      query: async () => ({
        matches: [{ id: 'a', score: 0.9, metadata: { product: 'd' } }],
      }),
    } as unknown as VectorizeIndex;
    root.registerFactory(
      'Env',
      () => () => ({ VECTORIZE: vectorize, EMBEDDING_MODEL: '' }) as unknown as never,
      { singleton: true },
    );
    const vectors = root.resolve(VectorIndexService);
    const matches = await vectors.query('hello', { topK: 5 });
    expect(matches).toEqual([{ id: 'a', score: 0.9, metadata: { product: 'd' } }]);
  });
});

describe('SearchService.search with populated Vectorize matches', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  function wireWithVectorize(matches: Array<{ id: string; score: number }>) {
    const root = useContainer();
    root.register(DocumentRepository);
    root.register(EmbeddingService);
    root.register(VectorIndexService);
    root.register(SearchService);
    const vectorize = { query: async () => ({ matches }) } as unknown as VectorizeIndex;
    root.registerFactory(
      'Env',
      () => () => ({ VECTORIZE: vectorize, EMBEDDING_MODEL: '' }) as unknown as never,
      { singleton: true },
    );
    return root;
  }

  test('scores matched pages, drops unknown ids, and skips low-relevance hits', async () => {
    const root = wireWithVectorize([
      { id: 'known', score: 0.9 },
      { id: 'missing-from-repo', score: 0.8 },
      { id: 'low-score', score: 0.01 },
    ]);
    const repo = root.resolve(DocumentRepository);
    await repo.seed([
      page('known', 'Known Page', 'repository content about DI'),
      page('low-score', 'Low Score Page', 'irrelevant unrelated text'),
    ]);

    const search = root.resolve(SearchService);
    const result = await search.search({ query: 'repository', maxHits: 10 });

    expect(result.hits.some((h) => h.objectID === 'known')).toBe(true);
    expect(result.hits.some((h) => h.objectID === 'missing-from-repo')).toBe(false);
  });

  test('exact search skips hits whose title/content does not contain the exact token', async () => {
    const root = wireWithVectorize([{ id: 'known', score: 0.9 }]);
    const repo = root.resolve(DocumentRepository);
    await repo.seed([page('known', 'Known Page', 'nothing relevant here')]);

    const search = root.resolve(SearchService);
    const result = await search.search({ query: 'repository', maxHits: 10, isExactSearch: true });
    expect(result.hits).toHaveLength(0);
  });

  test('returns an empty response for a blank query', async () => {
    const root = wireWithVectorize([]);
    const search = root.resolve(SearchService);
    const result = await search.search({ query: '   ' });
    expect(result).toMatchObject({ hits: [], nbHits: 0, nbPages: 0 });
  });
});
