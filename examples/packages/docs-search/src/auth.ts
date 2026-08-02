import * as jose from 'jose';
import type { Env } from './env';

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS = jose.createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`));

export type AuthResult =
  | { ok: true; via: 'github-oidc' | 'reindex-token'; subject: string }
  | { ok: false; status: number; error: string };

/**
 * Accept either:
 * 1. GitHub Actions OIDC JWT (CI — no long-lived secrets in the repo)
 * 2. Short-lived reindex token minted by this worker (POST /auth/token)
 */
export async function authorizeReindex(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token>' };
  }
  const token = match[1].trim();

  // Worker-issued reindex token (HS256)
  const reindex = await verifyReindexToken(token, env);
  if (reindex.ok) return reindex;

  // GitHub Actions OIDC
  return verifyGitHubOidc(token, env);
}

export async function verifyGitHubOidc(token: string, env: Env): Promise<AuthResult> {
  const audience = env.GITHUB_OIDC_AUDIENCE || 'di-framework-docs-search';
  const allowedRepo = env.GITHUB_REPOSITORY || 'di-framework/di-framework';

  try {
    const { payload } = await jose.jwtVerify(token, GITHUB_JWKS, {
      issuer: GITHUB_ISSUER,
      audience,
    });

    const repository = String(payload.repository ?? '');
    if (repository !== allowedRepo) {
      return {
        ok: false,
        status: 403,
        error: `repository claim "${repository}" is not allowed`,
      };
    }

    // Prefer main; allow workflow_dispatch from any ref of this repo if configured
    const ref = String(payload.ref ?? '');
    const requireMain = env.GITHUB_OIDC_REQUIRE_MAIN !== 'false';
    if (requireMain && ref !== 'refs/heads/main') {
      return {
        ok: false,
        status: 403,
        error: `ref "${ref}" is not refs/heads/main`,
      };
    }

    return {
      ok: true,
      via: 'github-oidc',
      subject: String(payload.sub ?? repository),
    };
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: err instanceof Error ? err.message : 'Invalid GitHub OIDC token',
    };
  }
}

/** Mint a short-lived token for /reindex (signed only on the Worker). */
export async function issueReindexToken(
  env: Env,
  claims: { sub: string; via: string },
): Promise<{ token: string; expiresAt: string; expiresIn: number }> {
  const secret = env.TOKEN_SIGNING_KEY;
  if (!secret) {
    throw new Error('TOKEN_SIGNING_KEY is not configured on the Worker');
  }
  const expiresIn = Number(env.REINDEX_TOKEN_TTL_SECONDS || 600);
  const key = await hmacKey(secret);
  const token = await new jose.SignJWT({
    purpose: 'reindex',
    via: claims.via,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setIssuer('di-framework-docs-search')
    .setAudience('di-framework-docs-search-reindex')
    .sign(key);

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return { token, expiresAt, expiresIn };
}

async function verifyReindexToken(token: string, env: Env): Promise<AuthResult> {
  const secret = env.TOKEN_SIGNING_KEY;
  if (!secret) {
    return { ok: false, status: 401, error: 'Reindex tokens not configured' };
  }
  try {
    const key = await hmacKey(secret);
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: 'di-framework-docs-search',
      audience: 'di-framework-docs-search-reindex',
    });
    if (payload.purpose !== 'reindex') {
      return { ok: false, status: 403, error: 'Token purpose is not reindex' };
    }
    return {
      ok: true,
      via: 'reindex-token',
      subject: String(payload.sub ?? 'reindex'),
    };
  } catch {
    return { ok: false, status: 401, error: 'Invalid reindex token' };
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
