import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { getEnv } from './bootstrap';
import type { Env } from './env';
import worker from './index';
import { DocPage } from './models/DocPage';
import { DocumentRepository } from './repositories/DocumentRepository';

// Must run before any `worker.fetch(...)` call in this file (the first such
// call binds the module-level env for the rest of the process), so it proves
// `getEnv()` really does throw when nothing has bound an `Env` yet.
test('getEnv() throws before bindEnv() has ever run', () => {
  expect(() => getEnv()).toThrow('Env not bound');
});

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

function testEnv(over: Partial<Env> = {}): Env {
  return {
    AI: undefined as unknown as Ai,
    VECTORIZE: undefined as unknown as VectorizeIndex,
    DOCS_BASE_URL: 'https://example.test',
    EMBEDDING_MODEL: '@cf/google/embeddinggemma-300m',
    CORS_ORIGINS: '*',
    TOKEN_SIGNING_KEY: 'test-signing-key-for-hmac-at-least-32b!',
    GITHUB_OIDC_AUDIENCE: 'di-framework-docs-search',
    GITHUB_REPOSITORY: 'di-framework/di-framework',
    GITHUB_OIDC_REQUIRE_MAIN: 'true',
    ...over,
  };
}

describe('HTTP API (Controller → Service → Repo)', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  test('GET / returns health via HealthController', async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request('http://localhost/'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; docsIndexed: number; showcase: string[] };
    expect(body.service).toBe('di-framework-docs-search');
    expect(body.showcase).toContain('@di-framework/http');
    expect(typeof body.docsIndexed).toBe('number');
  });

  test('strips BASE_PATH before routing', async () => {
    const env = testEnv({ BASE_PATH: '/api/docs/search' });
    const res = await worker.fetch(
      new Request('http://localhost/api/docs/search/'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe('di-framework-docs-search');
  });

  test('GET /preview-search/:project/:instance searches via SearchController', async () => {
    const env = testEnv();
    await worker.fetch(new Request('http://localhost/'), env, {} as ExecutionContext);
    const repo = useContainer().resolve(DocumentRepository);
    await repo.save(page('docs_gamma', 'Gamma', 'brand new gamma page about repositories'));

    const res = await worker.fetch(
      new Request('http://localhost/preview-search/docs/d?query=gamma&maxHits=5'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { objectID: string }[] };
    expect(body.hits.some((h) => h.objectID === 'docs_gamma')).toBe(true);
  });

  test('GET /preview-search/:project/:instance/:version scopes hits to that snapshot', async () => {
    const env = testEnv();
    await worker.fetch(new Request('http://localhost/'), env, {} as ExecutionContext);
    const repo = useContainer().resolve(DocumentRepository);
    await repo.save(page('docs_gamma', 'Gamma', 'gamma on latest', 'd'));
    await repo.save(
      Object.assign(page('docs_gamma__v4.1', 'Gamma', 'gamma on historic 4.1', 'd'), {
        version: 'v4.1',
      }),
    );

    const latest = await worker.fetch(
      new Request('http://localhost/preview-search/docs/d/latest?query=gamma&maxHits=5'),
      env,
      {} as ExecutionContext,
    );
    const latestBody = (await latest.json()) as { hits: { objectID: string }[] };
    expect(latestBody.hits.map((h) => h.objectID)).toEqual(['docs_gamma']);

    const old = await worker.fetch(
      new Request('http://localhost/preview-search/docs/d/v4.1?query=gamma&maxHits=5'),
      env,
      {} as ExecutionContext,
    );
    const oldBody = (await old.json()) as { hits: { objectID: string }[] };
    expect(oldBody.hits.map((h) => h.objectID)).toEqual(['docs_gamma__v4.1']);
  });

  test('POST /auth/token rejects missing bearer', async () => {
    const env = testEnv();
    const res = await worker.fetch(
      new Request('http://localhost/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Bearer');
  });

  test('POST /reindex rejects missing auth', async () => {
    const env = testEnv();
    const res = await worker.fetch(
      new Request('http://localhost/reindex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const env = testEnv();
    const res = await worker.fetch(
      new Request('http://localhost/reindex', { method: 'OPTIONS' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  test('unknown path returns 404 JSON', async () => {
    const env = testEnv();
    const res = await worker.fetch(
      new Request('http://localhost/noop'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not found');
  });
});
