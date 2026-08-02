import { describe, expect, test } from 'bun:test';
import * as jose from 'jose';
import { issueReindexToken, verifyGitHubOidc } from './auth';
import type { Env } from './env';

function baseEnv(over: Partial<Env> = {}): Env {
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

describe('worker-issued reindex tokens', () => {
  test('mint and verify via authorize path (HS256)', async () => {
    const env = baseEnv();
    const issued = await issueReindexToken(env, {
      sub: 'repo:di-framework/di-framework:ref:refs/heads/main',
      via: 'github-oidc',
    });
    expect(issued.token.split('.')).toHaveLength(3);
    expect(issued.expiresIn).toBeGreaterThan(0);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.TOKEN_SIGNING_KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const { payload } = await jose.jwtVerify(issued.token, key, {
      issuer: 'di-framework-docs-search',
      audience: 'di-framework-docs-search-reindex',
    });
    expect(payload.purpose).toBe('reindex');
  });
});

describe('GitHub OIDC gate', () => {
  test('rejects garbage token', async () => {
    const res = await verifyGitHubOidc('not.a.jwt', baseEnv());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });
});
