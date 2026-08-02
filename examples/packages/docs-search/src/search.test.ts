import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { DocPage } from './models/DocPage';
import { DocumentRepository } from './repositories/DocumentRepository';
import { bagOfChars, cosineSimilarity, EmbeddingService } from './services/EmbeddingService';
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

  test('cosine similarity of identical bags is ~1', () => {
    const a = bagOfChars('hello world', 16);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
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

    const res = await search.search({ query: 'gamma brand new', maxHits: 5 });
    expect(res.hits.some((h) => h.objectID === 'c')).toBe(true);

    // beta should not appear via vector path (deleted); lexical fallback only if vectors empty for query
    const beta = await search.search({ query: 'beta content repositories', maxHits: 5 });
    // may still hit a via weak similarity; assert b is gone from hits
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
