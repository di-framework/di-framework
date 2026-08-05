import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as jose from 'jose';
import { authorizeReindex, issueReindexToken, verifyGitHubOidc } from './auth';
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

/**
 * `verifyGitHubOidc` verifies against a real (network-fetched) JWKS. Rather
 * than let any test hit the real `token.actions.githubusercontent.com`
 * endpoint — which would poison the module-level, cooldown-cached
 * `RemoteJWKSet` with keys we don't hold the private half of — every fetch to
 * that endpoint is intercepted for the whole file, up front, and answered
 * with a locally generated key pair's public JWK. Tokens are then signed
 * with the matching private key, so the real `jose.jwtVerify` codepath (not
 * just our own logic around it) runs for real.
 */
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const KID = 'test-kid-1';
let privateKey: CryptoKey;
let originalFetch: typeof fetch;

beforeAll(async () => {
  const { privateKey: sk, publicKey } = await jose.generateKeyPair('RS256', {
    extractable: true,
  });
  privateKey = sk;
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input.toString();
    if (href.startsWith(`${GITHUB_ISSUER}/.well-known/jwks`)) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function signGitHubToken(claims: Record<string, unknown>, audience: string) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(GITHUB_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
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

  test('throws when TOKEN_SIGNING_KEY is not configured', async () => {
    const env = baseEnv({ TOKEN_SIGNING_KEY: '' });
    await expect(issueReindexToken(env, { sub: 'x', via: 'github-oidc' })).rejects.toThrow(
      'TOKEN_SIGNING_KEY is not configured',
    );
  });
});

describe('GitHub OIDC gate', () => {
  test('rejects garbage token', async () => {
    const res = await verifyGitHubOidc('not.a.jwt', baseEnv());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test('accepts a valid token for the allowed repository on refs/heads/main', async () => {
    const env = baseEnv();
    const token = await signGitHubToken(
      {
        sub: 'repo:di-framework/di-framework:ref:refs/heads/main',
        repository: env.GITHUB_REPOSITORY,
        ref: 'refs/heads/main',
      },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const res = await verifyGitHubOidc(token, env);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.via).toBe('github-oidc');
      expect(res.subject).toContain('di-framework/di-framework');
    }
  });

  test('falls back to the repository claim when sub is absent', async () => {
    const env = baseEnv();
    const token = await signGitHubToken(
      { repository: env.GITHUB_REPOSITORY, ref: 'refs/heads/main' },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const res = await verifyGitHubOidc(token, env);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.subject).toBe(env.GITHUB_REPOSITORY);
  });

  test('rejects a repository claim outside the allowed repo', async () => {
    const env = baseEnv();
    const token = await signGitHubToken(
      { repository: 'someone-else/fork', ref: 'refs/heads/main' },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const res = await verifyGitHubOidc(token, env);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error).toContain('not allowed');
    }
  });

  test('rejects a non-main ref when GITHUB_OIDC_REQUIRE_MAIN is not "false"', async () => {
    const env = baseEnv();
    const token = await signGitHubToken(
      { repository: env.GITHUB_REPOSITORY, ref: 'refs/heads/feature-x' },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const res = await verifyGitHubOidc(token, env);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error).toContain('refs/heads/main');
    }
  });

  test('allows a non-main ref when GITHUB_OIDC_REQUIRE_MAIN is "false"', async () => {
    const env = baseEnv({ GITHUB_OIDC_REQUIRE_MAIN: 'false' });
    const token = await signGitHubToken(
      { repository: env.GITHUB_REPOSITORY, ref: 'refs/heads/workflow-dispatch' },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const res = await verifyGitHubOidc(token, env);
    expect(res.ok).toBe(true);
  });
});

describe('authorizeReindex', () => {
  test('rejects a request without an Authorization header', async () => {
    const req = new Request('https://example.test/reindex', { method: 'POST' });
    const res = await authorizeReindex(req, baseEnv());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('Bearer');
    }
  });

  test('rejects a garbage bearer token via both the reindex-token and OIDC paths', async () => {
    const req = new Request('https://example.test/reindex', {
      method: 'POST',
      headers: { authorization: 'Bearer garbage.not-a-jwt.at-all' },
    });
    const res = await authorizeReindex(req, baseEnv());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test('rejects a garbage bearer token when reindex tokens are not configured', async () => {
    const req = new Request('https://example.test/reindex', {
      method: 'POST',
      headers: { authorization: 'Bearer garbage.not-a-jwt.at-all' },
    });
    const res = await authorizeReindex(req, baseEnv({ TOKEN_SIGNING_KEY: '' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  test('accepts a worker-minted reindex token end to end', async () => {
    const env = baseEnv();
    const issued = await issueReindexToken(env, { sub: 'ci-runner', via: 'github-oidc' });
    const req = new Request('https://example.test/reindex', {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const res = await authorizeReindex(req, env);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.via).toBe('reindex-token');
      expect(res.subject).toBe('ci-runner');
    }
  });

  test('rejects a reindex token whose purpose claim is not "reindex"', async () => {
    const env = baseEnv();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.TOKEN_SIGNING_KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const token = await new jose.SignJWT({ purpose: 'not-reindex' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('someone')
      .setIssuedAt()
      .setExpirationTime('10m')
      .setIssuer('di-framework-docs-search')
      .setAudience('di-framework-docs-search-reindex')
      .sign(key);

    const req = new Request('https://example.test/reindex', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await authorizeReindex(req, env);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401); // falls through to (also-failing) OIDC check
  });

  test('accepts a valid GitHub OIDC token end to end', async () => {
    const env = baseEnv();
    const token = await signGitHubToken(
      { repository: env.GITHUB_REPOSITORY, ref: 'refs/heads/main' },
      env.GITHUB_OIDC_AUDIENCE,
    );
    const req = new Request('https://example.test/reindex', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await authorizeReindex(req, env);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.via).toBe('github-oidc');
  });
});
