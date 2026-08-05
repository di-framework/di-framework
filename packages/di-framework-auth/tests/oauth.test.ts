import { describe, expect, it } from 'bun:test';
import { base64UrlEncode } from '../src/crypto/base64url.ts';
import { sha256 } from '../src/crypto/hash.ts';
import { AuthError } from '../src/errors.ts';
import { oauthClient } from '../src/oauth/client.ts';
import { discovery, validateMetadata, wellKnownUrl } from '../src/oauth/discovery.ts';
import { computeTokenHash, validateIdToken } from '../src/oauth/id-token.ts';
import {
  computeS256Challenge,
  generateCodeVerifier,
  generatePkce,
  isValidCodeVerifier,
} from '../src/oauth/pkce.ts';
import {
  genericOidcProvider,
  githubProvider,
  googleProvider,
  microsoftEntraProvider,
} from '../src/oauth/presets.ts';
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

  it('rejects a non-object document', () => {
    expect(() => validateMetadata(null, issuer)).toThrow(/not a JSON object/);
    expect(() => validateMetadata([1, 2, 3], issuer)).toThrow(/not a JSON object/);
  });

  it('rejects an endpoint that is not a valid URL', () => {
    expect(() =>
      validateMetadata({ ...valid, token_endpoint: 'not a url at all::::' }, issuer),
    ).toThrow(/is not a valid URL/);
  });
});

describe('discovery()', () => {
  const issuer = 'https://idp.example.com';
  const metadataDoc = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
    code_challenge_methods_supported: ['S256'],
  };

  function fetchStub(handler: () => Response) {
    return (async () => handler()) as typeof fetch;
  }

  it('fetches, validates, and caches the document; refresh() forces a re-fetch', async () => {
    let calls = 0;
    const fetchImpl = fetchStub(() => {
      calls++;
      return new Response(JSON.stringify(metadataDoc), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    let clock = 0;
    const client = discovery(issuer, { fetch: fetchImpl, now: () => clock });

    expect((await client.get()).issuer).toBe(issuer);
    expect((await client.get()).issuer).toBe(issuer);
    expect(calls).toBe(1); // second get() is served from cache

    await client.refresh();
    expect(calls).toBe(2);
  });

  it('serves the stale cached document when a refetch fails within maxStaleMs', async () => {
    let succeed = true;
    const fetchImpl = fetchStub(() => {
      if (succeed) {
        return new Response(JSON.stringify(metadataDoc), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('boom', { status: 500 });
    });
    let clock = 0;
    const client = discovery(issuer, {
      fetch: fetchImpl,
      now: () => clock,
      cacheTtlMs: 10,
      maxStaleMs: 10_000,
    });

    expect((await client.get()).issuer).toBe(issuer);
    succeed = false;
    clock = 1_000; // past cacheTtlMs, forcing a refetch attempt
    expect((await client.get()).issuer).toBe(issuer); // served stale, not thrown
  });

  it('throws when the refetch fails and there is no usable stale cache', async () => {
    const fetchImpl = fetchStub(() => new Response('boom', { status: 500 }));
    const client = discovery(issuer, { fetch: fetchImpl, now: () => 0 });
    await expect(client.get()).rejects.toThrow();
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

describe('validateIdToken', () => {
  const issuer = 'https://idp.example.com';
  const clientId = 'client-123';

  async function build() {
    const pair = await generateKeyPair('ES256');
    const key = await importJwk(pair.publicJwk, 'ES256', 'verify');
    const signingKey = await importJwk(pair.privateJwk, 'ES256', 'sign');
    const jwks = { getKey: async () => key };
    const sign = (claims: Record<string, unknown>, subject = 'u1') =>
      signJwt(claims, {
        algorithm: 'ES256',
        key: signingKey,
        issuer,
        audience: clientId,
        subject,
        expiresInSeconds: 60,
      });
    return { jwks, sign };
  }

  it('rejects a token with no sub claim', async () => {
    const { jwks, sign } = await build();
    const noSub = await sign({}, '');
    await expect(
      validateIdToken(noSub, { issuer, clientId, nonce: null, algorithms: ['ES256'], jwks }),
    ).rejects.toThrow(/no sub claim/);
  });

  it('rejects when azp is present and disagrees with the client', async () => {
    const { jwks, sign } = await build();
    const token = await sign({ azp: 'someone-else' });
    await expect(
      validateIdToken(token, { issuer, clientId, nonce: null, algorithms: ['ES256'], jwks }),
    ).rejects.toThrow(/azp/);
  });

  it('accepts a matching azp with multiple audiences', async () => {
    const { jwks, sign } = await build();
    const token = await sign({ aud: [clientId, 'other-client'], azp: clientId });
    await expect(
      validateIdToken(token, { issuer, clientId, nonce: null, algorithms: ['ES256'], jwks }),
    ).resolves.toMatchObject({ sub: 'u1' });
  });

  it('requires auth_time when max_age was requested, and enforces it', async () => {
    const { jwks, sign } = await build();
    const missingAuthTime = await sign({});
    await expect(
      validateIdToken(missingAuthTime, {
        issuer,
        clientId,
        nonce: null,
        algorithms: ['ES256'],
        jwks,
        maxAgeSeconds: 300,
      }),
    ).rejects.toThrow(/no auth_time/);

    const stale = await sign({ auth_time: 0 });
    await expect(
      validateIdToken(stale, {
        issuer,
        clientId,
        nonce: null,
        algorithms: ['ES256'],
        jwks,
        maxAgeSeconds: 1,
        now: () => 1_000,
      }),
    ).rejects.toThrow(/older than max_age/);

    const fresh = await sign({ auth_time: 1_000 });
    await expect(
      validateIdToken(fresh, {
        issuer,
        clientId,
        nonce: null,
        algorithms: ['ES256'],
        jwks,
        maxAgeSeconds: 300,
        now: () => 1_000,
      }),
    ).resolves.toMatchObject({ sub: 'u1' });
  });

  it('rejects an at_hash that does not match the access token', async () => {
    const { jwks, sign } = await build();
    const token = await sign({ at_hash: 'bogus' });
    await expect(
      validateIdToken(token, {
        issuer,
        clientId,
        nonce: null,
        algorithms: ['ES256'],
        jwks,
        accessToken: 'the-access-token',
      }),
    ).rejects.toThrow(/at_hash/);
  });

  it('rejects a c_hash that does not match the authorization code', async () => {
    const { jwks, sign } = await build();
    const token = await sign({ c_hash: 'bogus' });
    await expect(
      validateIdToken(token, {
        issuer,
        clientId,
        nonce: null,
        algorithms: ['ES256'],
        jwks,
        code: 'the-code',
      }),
    ).rejects.toThrow(/c_hash/);
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

  it('configures a generic OIDC provider by issuer, defaulting clientAuth from clientSecret', () => {
    const noSecret = genericOidcProvider({ ...config, issuer: 'https://idp.example.com' });
    expect(noSecret.id).toBe('oidc');
    expect(noSecret.clientAuth).toBe('none');

    const withSecret = genericOidcProvider({
      ...config,
      id: 'my-idp',
      issuer: 'https://idp.example.com',
      clientSecret: 's3cret',
      extraAuthorizationParams: { prompt: 'consent' },
    });
    expect(withSecret.id).toBe('my-idp');
    expect(withSecret.clientAuth).toBe('client_secret_basic');
    expect(withSecret.clientSecret).toBe('s3cret');
    expect(withSecret.extraAuthorizationParams).toEqual({ prompt: 'consent' });

    const explicitAuth = genericOidcProvider({
      ...config,
      issuer: 'https://idp.example.com',
      clientAuth: 'client_secret_post',
      clientSecret: 's3cret',
    });
    expect(explicitAuth.clientAuth).toBe('client_secret_post');
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

describe('oauthClient — token endpoint and userinfo mechanics', () => {
  const provider = (overrides: Partial<OAuthProvider> = {}): OAuthProvider => ({
    id: 'idp',
    clientId: 'client-1',
    redirectUri: 'https://app.example.com/cb',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    userinfoEndpoint: 'https://idp.example.com/userinfo',
    oidc: false,
    ...overrides,
  });

  const client = (fetchImpl: typeof fetch, overrides: Partial<OAuthProvider> = {}) =>
    oauthClient(provider(overrides), { state: memoryStateStore(), fetch: fetchImpl });

  it('fails requireEndpoint when neither an issuer nor an explicit endpoint is configured', async () => {
    const bare = oauthClient(
      { id: 'idp', clientId: 'c', redirectUri: 'https://app.example.com/cb' },
      { state: memoryStateStore() },
    );
    await expect(bare.authorizationUrl()).rejects.toThrow(/has no authorization_endpoint/);
  });

  it('sends client_secret_post credentials in the token request body', async () => {
    let capturedBody: URLSearchParams | undefined;
    const fetchImpl = (async (_url, init) => {
      capturedBody = new URLSearchParams(init?.body as string);
      return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const tokens = await client(fetchImpl, { clientAuth: 'client_secret_post', clientSecret: 'shh' })
      .refresh('rt');
    expect(capturedBody?.get('client_secret')).toBe('shh');
    expect(capturedBody?.get('grant_type')).toBe('refresh_token');
    expect(tokens.accessToken).toBe('at');
  });

  it('rejects a non-JSON token response', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    await expect(client(fetchImpl).refresh('rt')).rejects.toThrow(/non-JSON response/);
  });

  it('rejects a non-2xx token response without leaking error_description as the public message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    await expect(client(fetchImpl).refresh('rt')).rejects.toThrow(/HTTP 400/);
  });

  it('rejects a token response missing access_token or with a non-Bearer token_type', async () => {
    const respond = (body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

    await expect(client(respond({ token_type: 'Bearer' })).refresh('rt')).rejects.toThrow(
      /no access_token/,
    );
    await expect(
      client(respond({ access_token: 'at', token_type: 'Basic' })).refresh('rt'),
    ).rejects.toThrow(/not Bearer/);
  });

  it('rejects a userinfo response that is not ok, or not a JSON object', async () => {
    const notOk = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(client(notOk).userinfo('at')).rejects.toThrow(/HTTP 500/);

    const notObject = (async () =>
      new Response('[1,2,3]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await expect(client(notObject).userinfo('at')).rejects.toThrow(/not a JSON object/);
  });

  it('endSessionUrl returns null without an end_session_endpoint', async () => {
    const noDiscovery = client((async () => new Response('not found', { status: 404 })) as typeof fetch);
    expect(await noDiscovery.endSessionUrl({})).toBeNull();
  });

  it('endSessionUrl builds a URL with the id token hint and post-logout redirect, via discovery', async () => {
    const fetchImpl = (async (url) => {
      const href = typeof url === 'string' ? url : (url as URL).href ?? (url as Request).url;
      if (href.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://idp.example.com',
            authorization_endpoint: 'https://idp.example.com/authorize',
            token_endpoint: 'https://idp.example.com/token',
            jwks_uri: 'https://idp.example.com/keys',
            end_session_endpoint: 'https://idp.example.com/logout',
            code_challenge_methods_supported: ['S256'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const withIssuer = client(fetchImpl, { issuer: 'https://idp.example.com', tokenEndpoint: undefined });
    const url = await withIssuer.endSessionUrl({
      idToken: 'the-id-token',
      postLogoutRedirectUri: 'https://app.example.com/bye',
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe('https://idp.example.com/logout');
    expect(parsed.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/bye');
  });

  it('authorizationUrl carries max_age and extra authorization params', async () => {
    const authorization = await client(
      (async () => new Response('not found', { status: 404 })) as typeof fetch,
    ).authorizationUrl({ maxAgeSeconds: 120 });
    const url = new URL(authorization.url);
    expect(url.searchParams.get('max_age')).toBe('120');
  });

  it('authorizationUrl copies extraAuthorizationParams onto the URL', async () => {
    const authorization = await client(
      (async () => new Response('not found', { status: 404 })) as typeof fetch,
      { extraAuthorizationParams: { audience: 'https://api.example.com' } },
    ).authorizationUrl();
    const url = new URL(authorization.url);
    expect(url.searchParams.get('audience')).toBe('https://api.example.com');
  });
});

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
