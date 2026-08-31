import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { hydrateCorpus, persistCorpus } from './corpus-state';
import type { Env } from './env';
import { DocPage } from './models/DocPage';
import { DocumentRepository } from './repositories/DocumentRepository';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

function envWithKv(kv?: KVNamespace): Env {
  return { INDEX_STATE: kv } as Env;
}

describe('corpus KV persist/hydrate', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  test('persist and hydrate are no-ops without INDEX_STATE', async () => {
    const root = useContainer();
    root.register(DocumentRepository);
    const repo = root.resolve(DocumentRepository);
    await persistCorpus(envWithKv(), repo);
    expect(await hydrateCorpus(envWithKv(), repo)).toBe(false);
  });

  test('round-trips pages through KV and rejects empty or invalid payloads', async () => {
    const { kv, store } = memoryKv();
    const env = envWithKv(kv);
    const root = useContainer();
    root.register(DocumentRepository);
    const repo = root.resolve(DocumentRepository);
    await repo.save(
      Object.assign(new DocPage(), {
        id: 'docs_overview',
        url: 'https://example.test/overview.html',
        pageTitle: 'Overview',
        mainTitle: 'Overview',
        breadcrumbs: 'Docs|Overview',
        content: 'body',
        product: 'd',
        version: 'latest',
      }),
    );

    await persistCorpus(env, repo);
    expect(store.get('corpus-docs')).toContain('docs_overview');

    useContainer().clear();
    const next = useContainer();
    next.register(DocumentRepository);
    const empty = next.resolve(DocumentRepository);
    expect(await hydrateCorpus(env, empty)).toBe(true);
    expect(await empty.count()).toBe(1);

    store.set('corpus-docs', 'not-json');
    expect(await hydrateCorpus(env, empty)).toBe(false);

    store.set('corpus-docs', '[]');
    expect(await hydrateCorpus(env, empty)).toBe(false);

    store.delete('corpus-docs');
    expect(await hydrateCorpus(env, empty)).toBe(false);
  });
});
