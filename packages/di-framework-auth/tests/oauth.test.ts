import { describe, expect, it } from 'bun:test';
import { base64UrlEncode } from '../src/crypto/base64url.ts';
import { sha256 } from '../src/crypto/hash.ts';
import { AuthError } from '../src/errors.ts';
import { oauthClient } from '../src/oauth/client.ts';
import { validateMetadata, wellKnownUrl } from '../src/oauth/discovery.ts';
import { computeTokenHash } from '../src/oauth/id-token.ts';
import {
  computeS256Challenge,
  generateCodeVerifier,
  generatePkce,
  isValidCodeVerifier,
} from '../src/oauth/pkce.ts';
import { githubProvider, googleProvider, microsoftEntraProvider } from '../src/oauth/presets.ts';
import type { OAuthProvider } from '../src/oauth/types.ts';
import { memoryStateStore } from '../src/providers/memory.ts';
import { generateKeyPair, importJwk } from '../src/tokens/jwk.ts';
import { signJwt } from '../src/tokens/jwt.ts';

describe('PKCE', () => {
  // RFC 7636 Appendix B.
  it('matches the RFC 7636 Appendix B test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await computeS256Challenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates verifiers inside the RFC 7636 §4.1 character and length range', async () => {
    for (let i = 0; i < 20; i++) {
      const verifier = generateCodeVerifier();
      expect(verifier).toHaveLength(43);
      expect(isValidCodeVerifier(verifier)).toBe(true);
    }
  });

  // RFC 9700 §2.1.1 makes PKCE mandatory; `plain` provides no protection at all.
  it('only ever produces S256', async () => {
    expect((await generatePkce()).codeChallengeMethod).toBe('S256');
  });

  it('rejects entropy outside the representable range', () => {
    expect(() => generateCodeVerifier(16)).toThrow(RangeError);
    expect(() => generateCodeVerifier(128)).toThrow(RangeError);
  });
});

describe('discovery', () => {
  const issuer = 'https://login.example.com/tenant/v2.0';
  const valid = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
    code_challenge_methods_supported: ['S256'],
  };

  // The well-known segment goes after the issuer's path, which is what trips
  // people up with tenant-scoped issuers.
  it('appends the well-known path after the issuer path', () => {
    expect(wellKnownUrl(issuer)).toBe(
      'https://login.example.com/tenant/v2.0/.well-known/openid-configuration',
    );
    expect(wellKnownUrl('https://accounts.google.com/')).toBe(
      'https://accounts.google.com/.well-known/openid-configuration',
    );
  });

  it('accepts a well-formed document', () => {
    expect(validateMetadata(valid, issuer).issuer).toBe(issuer);
  });

  // OIDC Discovery §4.3 — the impersonation defence. A byte comparison, with no
  // trailing-slash forgiveness.
  it('requires the issuer to match exactly', () => {
    expect(() => validateMetadata({ ...valid, issuer: `${issuer}/` }, issuer)).toThrow(
      /does not exactly match/,
    );
    expect(() => validateMetadata({ ...valid, issuer: 'https://evil.example' }, issuer)).toThrow(
      AuthError,
    );
  });

  it('requires HTTPS endpoints', () => {
    expect(() =>
      validateMetadata({ ...valid, token_endpoint: 'http://login.example.com/token' }, issuer),
    ).toThrow(/must use HTTPS/);
  });

  it('permits http only for loopback, and only when asked', () => {
    const local = 'http://localhost:8080';
    const document = {
      issuer: local,
      authorization_endpoint: `${local}/authorize`,
      token_endpoint: `${local}/token`,
      jwks_uri: `${local}/keys`,
    };
    expect(() => validateMetadata(document, local)).toThrow(/must use HTTPS/);
    expect(validateMetadata(document, local, true).issuer).toBe(local);
  });

  // A provider that cannot do S256 is one we decline to talk to rather than
  // silently downgrade with.
  it('refuses a provider that does not advertise S256', () => {
    expect(() =>
      validateMetadata({ ...valid, code_challenge_methods_supported: ['plain'] }, issuer),
    ).toThrow(/PKCE S256/);
  });

  it('rejects a document missing required endpoints', () => {
    expect(() => validateMetadata({ issuer }, issuer)).toThrow(/authorization_endpoint/);
  });
});

describe('at_hash', () => {
  it('is the leftmost half of the digest implied by the signing algorithm', async () => {
    const accessToken = 'jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y';
    // OIDC Core §3.1.3.6 worked example.
    const digest = await sha256(accessToken);
    expect(await computeTokenHash(accessToken, 'RS256')).toBe(
      base64UrlEncode(digest.subarray(0, 16)),
    );
  });

  // The digest for EdDSA is not unambiguously pinned for this use, so we skip
  // rather than guess and reject valid tokens.
  it('returns null for EdDSA rather than guessing', async () => {
    expect(await computeTokenHash('token', 'EdDSA')).toBeNull();
  });
});

describe('presets', () => {
  const config = { clientId: 'cid', redirectUri: 'https://app.example.com/cb' };

  it('configures Google and Entra for discovery', () => {
    expect(googleProvider(config).issuer).toBe('https://accounts.google.com');
    expect(microsoftEntraProvider({ ...config, tenant: 'abc' }).issuer).toBe(
      'https://login.microsoftonline.com/abc/v2.0',
    );
  });

  // GitHub is here as the deliberate non-OIDC case: no discovery, no id_token,
  // no nonce. An interface that only ever saw OIDC providers would assume one.
  it('configures GitHub as plain OAuth2', () => {
    const provider = githubProvider(config);
    expect(provider.oidc).toBe(false);
    expect(provider.issuer).toBeUndefined();
    expect(provider.userinfoEndpoint).toBe('https://api.github.com/user');
    const profile = provider.profileMap!(null, { id: 42, login: 'ada', email: 'a@b.c' });
    expect(profile.subject).toBe('42');
    expect(profile.name).toBe('ada');
  });
});

/* -------------------------------------------------------------------------- */
/* Full authorization-code flow against a stub provider                       */
/* -------------------------------------------------------------------------- */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-123';
const REDIRECT = 'https://app.example.com/auth/oauth/idp/callback';

async function stubIdp(options: { nonceOverride?: string; subOverride?: string } = {}) {
  const pair = await generateKeyPair('ES256');
  const signingKey = await importJwk(pair.privateJwk, 'ES256', 'sign');
  const state = memoryStateStore();
  let lastTokenBody: URLSearchParams | undefined;

  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };

  let issuedNonce = '';

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/.well-known/openid-configuration')) return json(metadata);
    if (url === metadata.jwks_uri) return json({ keys: [pair.publicJwk] });

    if (url === metadata.token_endpoint) {
      lastTokenBody = new URLSearchParams(init!.body as string);
      const idToken = await signJwt(
        {
          nonce: options.nonceOverride ?? issuedNonce,
          auth_time: 1_000,
        },
        {
          algorithm: 'ES256',
          key: signingKey,
          kid: pair.kid,
          issuer: ISSUER,
          audience: CLIENT_ID,
          subject: 'idp-user-1',
          expiresInSeconds: 300,
        },
      );
      return json({
        access_token: 'access-token-value',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken,
        scope: 'openid profile email',
      });
    }

    if (url === metadata.userinfo_endpoint) {
      return json({ sub: options.subOverride ?? 'idp-user-1', email: 'ada@example.com' });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const provider: OAuthProvider = {
    id: 'idp',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    clientAuth: 'client_secret_basic',
    redirectUri: REDIRECT,
  };

  const client = oauthClient(provider, { state, fetch: fetchImpl });

  return {
    client,
    state,
    setNonce: (value: string) => {
      issuedNonce = value;
    },
    tokenBody: () => lastTokenBody,
  };
}

/** Drive `authorizationUrl` then build the matching callback request. */
async function startFlow(
  idp: Awaited<ReturnType<typeof stubIdp>>,
  overrides: Record<string, string> = {},
) {
  const authorization = await idp.client.authorizationUrl();
  idp.setNonce(authorization.nonce);

  const params = new URLSearchParams({
    code: 'auth-code',
    state: authorization.state,
    iss: ISSUER,
    ...overrides,
  });
  const cookieValue = overrides['__cookie'] ?? authorization.state;

  return {
    authorization,
    request: new Request(`${REDIRECT}?${params}`, {
      headers: { cookie: `__Host-oauth-state=${cookieValue}` },
    }),
  };
}

describe('authorization code flow', () => {
  it('builds an authorization URL with PKCE S256 and never a response_mode', async () => {
    const idp = await stubIdp();
    const authorization = await idp.client.authorizationUrl();
    const url = new URL(authorization.url);

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      await computeS256Challenge(authorization.codeVerifier),
    );
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('nonce')).toBe(authorization.nonce);
    // Reading only searchParams is what structurally forbids the implicit flow.
    expect(url.searchParams.get('response_mode')).toBeNull();
  });

  // SameSite=Strict would block the top-level cross-site navigation back from
  // the IdP, so every login would fail with "state mismatch".
  it('sets the state cookie SameSite=Lax, not Strict', async () => {
    const idp = await stubIdp();
    const { stateCookie } = await idp.client.authorizationUrl();
    expect(stateCookie).toContain('SameSite=Lax');
    expect(stateCookie).not.toContain('SameSite=Strict');
    expect(stateCookie).toContain('__Host-oauth-state=');
    expect(stateCookie).toContain('HttpOnly');
  });

  it('completes the flow and produces a principal', async () => {
    const idp = await stubIdp();
    const { request } = await startFlow(idp);
    const result = await idp.client.callback(request);

    expect(result.profile.subject).toBe('idp-user-1');
    expect(result.principal.method).toBe('oauth');
    expect(result.principal.issuer).toBe(ISSUER);
    expect(result.principal.scope).toEqual(['openid', 'profile', 'email']);
    expect(result.principal.authTime).toBe(1_000);
    expect(result.clearStateCookie).toContain('Max-Age=0');
  });

  it('sends the code_verifier and the original redirect_uri to the token endpoint', async () => {
    const idp = await stubIdp();
    const { authorization, request } = await startFlow(idp);
    await idp.client.callback(request);

    const body = idp.tokenBody()!;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe(authorization.codeVerifier);
    // RFC 6749 §4.1.3 requires the byte-identical redirect_uri.
    expect(body.get('redirect_uri')).toBe(REDIRECT);
  });

  // The atomic `consume` is what makes the callback non-replayable.
  it('rejects a replayed state', async () => {
    const idp = await stubIdp();
    const { request } = await startFlow(idp);
    await idp.client.callback(request.clone());
    await expect(idp.client.callback(request)).rejects.toThrow(/expired or was already used/);
  });

  // Binds the callback to the browser that started the flow (RFC 9700 §4.7).
  it('rejects a callback whose state cookie does not match', async () => {
    const idp = await stubIdp();
    const { request } = await startFlow(idp, { __cookie: 'a-different-state' });
    await expect(idp.client.callback(request)).rejects.toThrow(/does not match the state cookie/);
  });

  it('rejects a callback with no state cookie at all', async () => {
    const idp = await stubIdp();
    const authorization = await idp.client.authorizationUrl();
    const request = new Request(`${REDIRECT}?code=c&state=${authorization.state}&iss=${ISSUER}`);
    await expect(idp.client.callback(request)).rejects.toThrow(/state cookie/);
  });

  // RFC 9207 — the authorization-server mix-up defence.
  it('requires the iss parameter when the provider advertises it', async () => {
    const idp = await stubIdp();
    const authorization = await idp.client.authorizationUrl();
    const request = new Request(`${REDIRECT}?code=c&state=${authorization.state}`, {
      headers: { cookie: `__Host-oauth-state=${authorization.state}` },
    });
    await expect(idp.client.callback(request)).rejects.toThrow(/no iss parameter/);
  });

  it('rejects a mismatched iss parameter', async () => {
    const idp = await stubIdp();
    const { request } = await startFlow(idp, { iss: 'https://evil.example.com' });
    await expect(idp.client.callback(request)).rejects.toThrow(/does not match issuer/);
  });

  // The ID token's own replay defence, distinct from `state`.
  it('rejects a mismatched nonce', async () => {
    const idp = await stubIdp({ nonceOverride: 'not-the-nonce-we-sent' });
    const { request } = await startFlow(idp);
    await expect(idp.client.callback(request)).rejects.toThrow(/nonce does not match/);
  });

  // OIDC Core §5.3.2 — otherwise a confused userinfo endpoint can swap identities
  // after the token has already been validated.
  it('rejects a userinfo sub that disagrees with the ID token', async () => {
    const idp = await stubIdp({ subOverride: 'someone-else' });
    const { request } = await startFlow(idp);
    await expect(idp.client.callback(request)).rejects.toThrow(/Userinfo sub does not match/);
  });

  it('surfaces a provider error without leaking its text to the client', async () => {
    const idp = await stubIdp();
    const authorization = await idp.client.authorizationUrl();
    const request = new Request(
      `${REDIRECT}?error=access_denied&error_description=User+said+no&state=${authorization.state}`,
      { headers: { cookie: `__Host-oauth-state=${authorization.state}` } },
    );
    const error = (await idp.client.callback(request).catch((e) => e)) as AuthError;
    expect(error.code).toBe('oauth_error');
    expect(error.publicMessage).toBe('Sign-in failed');
    expect(error.detail).toMatchObject({ error: 'access_denied' });
  });
});
