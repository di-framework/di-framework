import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { generateOpenAPI, registry, TypedRouter } from '@di-framework/http';
import packageJson from '../package.json' with { type: 'json' };
import { chain } from '../src/chain.ts';
import { makeContext } from '../src/context.ts';
import { hashSecret } from '../src/crypto/hash.ts';
import { AuthError } from '../src/errors.ts';
import { withAuthErrors } from '../src/http/catch.ts';
import { optionalAuth, requireAuth, requireAuthExcept } from '../src/http/middleware.ts';
import { publicEndpoint, secured, securitySchemesFor } from '../src/http/openapi.ts';
import { getPrincipal, isAuthenticated, requirePrincipal } from '../src/http/request.ts';
import { applyAuthHeaders, withHeaders } from '../src/http/responses.ts';
import { mountAuthRoutes, optional, protect, withAuthRoutes } from '../src/http/router.ts';
import { createPrincipal } from '../src/principal.ts';
import {
  inMemoryAuthStores,
  memoryCredentialStore,
  memorySessionStore,
  memoryUserStore,
} from '../src/providers/memory.ts';
import type { SessionStore } from '../src/providers/types.ts';
import type { AuthRuntime } from '../src/register.ts';
import { registerAuth } from '../src/register.ts';
import { authenticated, authFailed, noCredential } from '../src/result.ts';
import { sessionManager } from '../src/session/manager.ts';
import { apiKeyStrategy, issueApiKey } from '../src/strategies/api-key.ts';
import { bearerTokenStrategy } from '../src/strategies/bearer.ts';
import { sessionCookieStrategy } from '../src/strategies/session-cookie.ts';
import { generateKeyPair, importJwk } from '../src/tokens/jwk.ts';
import { signJwt } from '../src/tokens/jwt.ts';
import { AUTH_RUNTIME, AUTH_SESSIONS, AUTH_STRATEGY, AUTH_WEBAUTHN } from '../src/tokens.ts';
import type { AuthContainer, AuthStrategy } from '../src/types.ts';
import type { WebAuthnService } from '../src/webauthn/service.ts';

const SECRET = 'z'.repeat(48);

const get = (url = 'https://app.example.com/me', headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe('package hygiene', () => {
  // Zero runtime dependencies is the constraint the whole crypto design follows
  // from, so it is asserted rather than assumed.
  it('declares no runtime dependencies', () => {
    expect((packageJson as { dependencies?: Record<string, string> }).dependencies).toBeUndefined();
  });

  // The optional-peer promise is only real if the root entry point cannot reach
  // them. A consumer doing bearer verification in a queue worker, with no
  // itty-router and no graphql installed, must still be able to import the
  // package — so this walks the actual module graph from index.ts.
  it('never reaches an optional peer from the root entry point', async () => {
    const optional = [
      'itty-router',
      'graphql',
      '@di-framework/repo',
      '@di-framework/http',
      '@di-framework/graphql',
    ];
    const root = new URL('../', import.meta.url).pathname;
    const seen = new Set<string>();
    const offenders: string[] = [];

    const walk = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await Bun.file(file).text();
      for (const match of source.matchAll(/from\s*'([^']+)'/g)) {
        const specifier = match[1]!;
        if (optional.includes(specifier)) offenders.push(`${file} imports ${specifier}`);
        if (!specifier.startsWith('.')) continue;
        await walk(new URL(specifier, `file://${file}`).pathname);
      }
    };

    await walk(`${root}index.ts`);
    expect(offenders).toEqual([]);
    // Sanity: the walk actually visited the module graph.
    expect(seen.size).toBeGreaterThan(20);
  });

  it('keeps the integrations behind subpath exports', () => {
    const exports = packageJson.exports as Record<string, unknown>;
    for (const subpath of ['.', './http', './graphql', './repo', './webauthn', './oauth']) {
      expect(exports[subpath]).toBeDefined();
    }
  });
});

describe('strategy chain', () => {
  const always = (result: ReturnType<typeof noCredential>): AuthStrategy => ({
    name: 'stub',
    authenticate: async () => result,
  });

  it('takes the first strategy that authenticates', async () => {
    const principal = createPrincipal({ sub: 'u1', method: 'bearer' });
    const composed = chain([
      { name: 'a', authenticate: async () => noCredential() },
      { name: 'b', authenticate: async () => authenticated(principal) },
      {
        name: 'c',
        authenticate: async () => authenticated(createPrincipal({ sub: 'u2', method: 'bearer' })),
      },
    ]);
    const result = await composed.authenticate(makeContext(get()));
    expect(result.state).toBe('authenticated');
    if (result.state === 'authenticated') expect(result.principal.sub).toBe('u1');
  });

  // Continuing past a failure would turn a rejected credential into a silently
  // downgraded anonymous request.
  it('stops at a failed credential rather than falling through', async () => {
    let reached = false;
    const composed = chain([
      { name: 'a', authenticate: async () => authFailed('invalid_token', 'bad token') },
      {
        name: 'b',
        authenticate: async () => {
          reached = true;
          return authenticated(createPrincipal({ sub: 'u1', method: 'session' }));
        },
      },
    ]);

    const result = await composed.authenticate(makeContext(get()));
    expect(result.state).toBe('failed');
    expect(reached).toBe(false);
  });

  it('reports no credential when nothing matched', async () => {
    const composed = chain([always(noCredential()), always(noCredential())]);
    expect((await composed.authenticate(makeContext(get()))).state).toBe('no-credential');
  });

  it('refuses an empty chain', () => {
    expect(() => chain([])).toThrow(/at least one strategy/);
  });

  it('fails a required strategy that found no credential, rather than falling through', async () => {
    let reached = false;
    const composed = chain(
      [
        { name: 'must-have', authenticate: async () => noCredential() },
        {
          name: 'fallback',
          authenticate: async () => {
            reached = true;
            return authenticated(createPrincipal({ sub: 'u1', method: 'session' }));
          },
        },
      ],
      { required: ['must-have'] },
    );

    const result = await composed.authenticate(makeContext(get()));
    expect(result.state).toBe('failed');
    expect(reached).toBe(false);
  });

  it('offers the first available challenge', () => {
    const composed = chain([
      { name: 'a', authenticate: async () => noCredential(), challenge: () => undefined },
      { name: 'b', authenticate: async () => noCredential(), challenge: () => 'Bearer' },
      { name: 'c', authenticate: async () => noCredential(), challenge: () => 'Basic' },
    ]);
    expect(composed.challenge?.(makeContext(get()))).toBe('Bearer');
  });
});

describe('AuthResult type guards', () => {
  it('isAuthenticated, isNoCredential, and isFailure narrow correctly', async () => {
    const {
      isAuthenticated: resultIsAuthenticated,
      isNoCredential,
      isFailure,
    } = await import('../src/result.ts');
    const principal = createPrincipal({ sub: 'u1', method: 'bearer' });
    const success = authenticated(principal);
    const empty = noCredential();
    const failure = authFailed('invalid_token', 'bad');

    expect(resultIsAuthenticated(success)).toBe(true);
    expect(resultIsAuthenticated(empty)).toBe(false);
    expect(resultIsAuthenticated(failure)).toBe(false);

    expect(isNoCredential(empty)).toBe(true);
    expect(isNoCredential(success)).toBe(false);
    expect(isNoCredential(failure)).toBe(false);

    expect(isFailure(failure)).toBe(true);
    expect(isFailure(success)).toBe(false);
    expect(isFailure(empty)).toBe(false);
  });
});

describe('authenticate() and requireAuthentication() helpers', () => {
  const principal = createPrincipal({ sub: 'u1', method: 'bearer' });
  const okStrategy: AuthStrategy = {
    name: 'ok',
    authenticate: async () => authenticated(principal),
  };
  const emptyStrategy: AuthStrategy = { name: 'empty', authenticate: async () => noCredential() };
  const failStrategy: AuthStrategy = {
    name: 'fail',
    authenticate: async () => authFailed('invalid_token', 'bad'),
  };

  it('authenticate() resolves the principal, undefined on no-credential, and throws on failure', async () => {
    const { authenticate } = await import('../src/chain.ts');
    expect(await authenticate(okStrategy, makeContext(get()))).toBe(principal);
    expect(await authenticate(emptyStrategy, makeContext(get()))).toBeUndefined();
    await expect(authenticate(failStrategy, makeContext(get()))).rejects.toBeInstanceOf(AuthError);
  });

  it('requireAuthentication() resolves the principal and throws AuthError otherwise', async () => {
    const { requireAuthentication } = await import('../src/chain.ts');
    expect(await requireAuthentication(okStrategy, makeContext(get()))).toBe(principal);
    await expect(requireAuthentication(failStrategy, makeContext(get()))).rejects.toBeInstanceOf(
      AuthError,
    );
    await expect(requireAuthentication(emptyStrategy, makeContext(get()))).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('requireAuthentication() falls back to the strategy challenge when none is passed explicitly', async () => {
    const { requireAuthentication } = await import('../src/chain.ts');
    const challenging: AuthStrategy = {
      name: 'challenging',
      authenticate: async () => noCredential(),
      challenge: () => 'Bearer realm="api"',
    };
    try {
      await requireAuthentication(challenging, makeContext(get()));
      throw new Error('expected requireAuthentication to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).challenges).toEqual(['Bearer realm="api"']);
    }
  });
});

describe('bearer strategy', () => {
  const build = async () => {
    const pair = await generateKeyPair('ES256');
    const key = await importJwk(pair.publicJwk, 'ES256', 'verify');
    const signingKey = await importJwk(pair.privateJwk, 'ES256', 'sign');
    return {
      signingKey,
      strategy: bearerTokenStrategy({
        algorithms: ['ES256'],
        key,
        issuer: 'https://iss',
        audience: 'api',
      }),
    };
  };

  it('authenticates a valid token and carries scope as data', async () => {
    const { strategy, signingKey } = await build();
    const token = await signJwt(
      { scope: 'read write', amr: ['pwd'] },
      {
        algorithm: 'ES256',
        key: signingKey,
        issuer: 'https://iss',
        audience: 'api',
        subject: 'u1',
        expiresInSeconds: 60,
      },
    );
    const result = await strategy.authenticate(
      makeContext(get(undefined, { authorization: `Bearer ${token}` })),
    );
    expect(result.state).toBe('authenticated');
    if (result.state === 'authenticated') {
      expect(result.principal.sub).toBe('u1');
      // Surfaced for domain code to interpret; this package never acts on it.
      expect(result.principal.scope).toEqual(['read', 'write']);
      expect(result.principal.amr).toEqual(['pwd']);
    }
  });

  it('reports no credential when the header belongs to another scheme', async () => {
    const { strategy } = await build();
    expect(
      (await strategy.authenticate(makeContext(get(undefined, { authorization: 'Basic abc' }))))
        .state,
    ).toBe('no-credential');
    expect((await strategy.authenticate(makeContext(get()))).state).toBe('no-credential');
  });

  it('fails, rather than passing through, on a malformed Bearer header', async () => {
    const { strategy } = await build();
    const result = await strategy.authenticate(
      makeContext(get(undefined, { authorization: 'Bearer' })),
    );
    expect(result.state).toBe('failed');
  });

  it('offers an RFC 6750 challenge without leaking the reason', async () => {
    const { strategy } = await build();
    const result = await strategy.authenticate(
      makeContext(get(undefined, { authorization: 'Bearer not.a.token' })),
    );
    expect(result.state).toBe('failed');
    if (result.state === 'failed') {
      expect(result.challenge).toBe('Bearer realm="api", error="invalid_token"');
    }
  });

  it('challenge() advertises the RFC 6750 realm', async () => {
    const { strategy } = await build();
    expect(strategy.challenge?.(makeContext(get()))).toBe('Bearer realm="api"');
  });

  it('fails a well-formed, well-signed token that carries no sub claim', async () => {
    const { strategy, signingKey } = await build();
    const token = await signJwt(
      {},
      {
        algorithm: 'ES256',
        key: signingKey,
        issuer: 'https://iss',
        audience: 'api',
        expiresInSeconds: 60,
      },
    );
    const result = await strategy.authenticate(
      makeContext(get(undefined, { authorization: `Bearer ${token}` })),
    );
    expect(result.state).toBe('failed');
    if (result.state === 'failed') {
      expect(result.code).toBe('invalid_token');
      expect(result.message).toContain('sub claim');
    }
  });
});

describe('session cookie strategy', () => {
  it('authenticates from the cookie', async () => {
    const sessions = sessionManager({ store: memorySessionStore() });
    const issued = await sessions.create({ subject: 'u1' });
    const strategy = sessionCookieStrategy({ sessions });

    const result = await strategy.authenticate(
      makeContext(get(undefined, { cookie: `__Host-sid=${issued.token}` })),
    );
    expect(result.state).toBe('authenticated');
  });

  it('reports no credential without a cookie', async () => {
    const strategy = sessionCookieStrategy({
      sessions: sessionManager({ store: memorySessionStore() }),
    });
    expect((await strategy.authenticate(makeContext(get()))).state).toBe('no-credential');
  });

  it('fails on an unknown or expired session token', async () => {
    const sessions = sessionManager({ store: memorySessionStore() });
    const strategy = sessionCookieStrategy({ sessions });

    const unknown = await strategy.authenticate(
      makeContext(get(undefined, { cookie: '__Host-sid=nonexistent' })),
    );
    expect(unknown.state).toBe('failed');
    if (unknown.state === 'failed') expect(unknown.code).toBe('session_not_found');

    let clock = 0;
    const expiring = sessionManager({
      store: memorySessionStore(),
      policy: { absoluteTimeoutSeconds: 10, inactivityTimeoutSeconds: 0, touchIntervalSeconds: 1 },
      now: () => clock,
    });
    const issued = await expiring.create({ subject: 'u1' });
    clock = 100;
    const expiredStrategy = sessionCookieStrategy({ sessions: expiring });
    const expired = await expiredStrategy.authenticate(
      makeContext(get(undefined, { cookie: `__Host-sid=${issued.token}` })),
    );
    expect(expired.state).toBe('failed');
    if (expired.state === 'failed') expect(expired.code).toBe('session_expired');
  });

  it('runs CSRF after the session resolves, and rejects with a 403 rather than a 401', async () => {
    const { csrfGuard } = await import('../src/csrf.ts');
    const sessions = sessionManager({ store: memorySessionStore() });
    const issued = await sessions.create({ subject: 'u1' });
    const csrf = csrfGuard({ secret: SECRET });
    const strategy = sessionCookieStrategy({ sessions, csrf });

    const post = (headers: Record<string, string> = {}) =>
      new Request('https://app.example.com/x', { method: 'POST', headers });

    const missingToken = await strategy.authenticate(
      makeContext(post({ cookie: `__Host-sid=${issued.token}` })),
    );
    expect(missingToken.state).toBe('failed');
    if (missingToken.state === 'failed') {
      expect(missingToken.code).toBe('csrf_failed');
      expect(missingToken.status).toBe(403);
    }

    const token = await csrf.issue(issued.record.id);
    const ok = await strategy.authenticate(
      makeContext(post({ cookie: `__Host-sid=${issued.token}`, [csrf.headerName]: token })),
    );
    expect(ok.state).toBe('authenticated');
  });
});

describe('api key strategy', () => {
  it('stores the key hashed and authenticates with the plaintext', async () => {
    const credentials = memoryCredentialStore();
    const { key, credential } = await issueApiKey(credentials, { userId: 'u1', prefix: 'dik' });

    expect(key.startsWith('dik_')).toBe(true);
    expect(credential.id).toBe(await hashSecret(key));

    const strategy = apiKeyStrategy({ credentials });
    const result = await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': key })));
    expect(result.state).toBe('authenticated');
    if (result.state === 'authenticated') expect(result.principal.sub).toBe('u1');
  });

  it('reports one message for unknown, disabled, and expired keys', async () => {
    const credentials = memoryCredentialStore();
    const strategy = apiKeyStrategy({ credentials, now: () => 10_000 });

    const unknown = await strategy.authenticate(
      makeContext(get(undefined, { 'x-api-key': 'nope' })),
    );
    const { key } = await issueApiKey(credentials, { userId: 'u1', expiresAt: 1 });
    const expired = await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': key })));

    expect(unknown.state).toBe('failed');
    expect(expired.state).toBe('failed');
    if (unknown.state === 'failed' && expired.state === 'failed') {
      expect(unknown.message).toBe(expired.message);
    }
  });

  it('also accepts the key from an Authorization header with a configured scheme', async () => {
    const credentials = memoryCredentialStore();
    const { key } = await issueApiKey(credentials, { userId: 'u1' });
    const strategy = apiKeyStrategy({ credentials, authorizationScheme: 'apikey' });

    const viaAuthHeader = await strategy.authenticate(
      makeContext(get(undefined, { authorization: `ApiKey ${key}` })),
    );
    expect(viaAuthHeader.state).toBe('authenticated');

    // Malformed / mismatched Authorization headers are simply "no credential".
    expect(
      (
        await strategy.authenticate(
          makeContext(get(undefined, { authorization: 'Bearer something' })),
        )
      ).state,
    ).toBe('no-credential');
    expect(
      (await strategy.authenticate(makeContext(get(undefined, { authorization: 'nospace' }))))
        .state,
    ).toBe('no-credential');
    expect((await strategy.authenticate(makeContext(get()))).state).toBe('no-credential');
  });

  it('does not require an Authorization header at all when no scheme is configured', async () => {
    const credentials = memoryCredentialStore();
    const strategy = apiKeyStrategy({ credentials });
    expect(
      (
        await strategy.authenticate(
          makeContext(get(undefined, { authorization: 'Bearer something' })),
        )
      ).state,
    ).toBe('no-credential');
  });

  it('rejects a key belonging to a missing or disabled user, when a UserStore is configured', async () => {
    const credentials = memoryCredentialStore();
    const users = memoryUserStore();
    const strategy = apiKeyStrategy({ credentials, users });

    const { key: orphanKey } = await issueApiKey(credentials, { userId: 'ghost' });
    expect(
      (await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': orphanKey })))).state,
    ).toBe('failed');

    const user = await users.create({ id: 'u1', identifier: 'ada', createdAt: 0 });
    await users.update(user.id, { disabled: true });
    const { key: disabledKey } = await issueApiKey(credentials, { userId: user.id });
    expect(
      (await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': disabledKey }))))
        .state,
    ).toBe('failed');
  });

  it('uses the wall-clock default for `now` when none is supplied', async () => {
    const credentials = memoryCredentialStore();
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const { key } = await issueApiKey(credentials, { userId: 'u1', expiresAt: future });
    const strategy = apiKeyStrategy({ credentials });
    const result = await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': key })));
    expect(result.state).toBe('authenticated');
  });

  it('tracks lastUsedAt when trackUsage is enabled', async () => {
    const credentials = memoryCredentialStore();
    const { key, credential } = await issueApiKey(credentials, { userId: 'u1' }, () => 1_000);
    const strategy = apiKeyStrategy({ credentials, trackUsage: true, now: () => 2_000 });

    await strategy.authenticate(makeContext(get(undefined, { 'x-api-key': key })));
    const stored = await credentials.findApiKey(credential.id);
    expect(stored?.lastUsedAt).toBe(2_000);
  });
});

describe('registerAuth', () => {
  beforeEach(() => {
    useContainer().clear();
  });

  it('registers a runtime and the stores under namespaced tokens', () => {
    const runtime = registerAuth({ secret: SECRET });
    const container = useContainer();

    expect(container.resolve<AuthRuntime>(AUTH_RUNTIME)).toBe(runtime);
    expect(container.resolve<AuthStrategy>(AUTH_STRATEGY)).toBe(runtime.strategy);
    expect(container.resolve<SessionStore>(AUTH_SESSIONS)).toBe(runtime.stores.sessions);
    // Namespaced so an application's own `UserStore` cannot be shadowed.
    expect(AUTH_SESSIONS.startsWith('auth.')).toBe(true);
  });

  it('refuses to start without a secret unless CSRF is explicitly disabled', () => {
    expect(() => registerAuth({})).toThrow(/needs a `secret`/);
    expect(() => registerAuth({ csrf: false })).not.toThrow();
  });

  it('rejects a secret below 32 bytes', () => {
    expect(() => registerAuth({ secret: 'too short' })).toThrow(RangeError);
  });

  it('composes session, bearer, and api-key strategies when jwt is configured', () => {
    const runtime = registerAuth({
      secret: SECRET,
      jwt: { issuer: 'https://iss', audience: 'api' },
    });
    expect(runtime.strategy.name).toBe('session+bearer+api-key');
    expect(runtime.tokens).toBeDefined();
    expect(runtime.refresh).toBeDefined();
  });

  it('accepts partial store overrides', () => {
    const custom = memorySessionStore();
    const runtime = registerAuth({ secret: SECRET, stores: { sessions: custom } });
    expect(runtime.stores.sessions).toBe(custom);
    expect(runtime.stores.users).toBeDefined();
  });

  it('issues an access token through the registered runtime', async () => {
    const runtime = registerAuth({
      secret: SECRET,
      jwt: { issuer: 'https://iss', audience: 'api', accessTtlSeconds: 60 },
    });
    const { token, expiresIn } = await runtime.tokens!.issueAccessToken({ subject: 'u1' });
    expect(expiresIn).toBe(60);

    const result = await runtime.strategy.authenticate(
      makeContext(get(undefined, { authorization: `Bearer ${token}` })),
    );
    expect(result.state).toBe('authenticated');
  });

  it('derives an HS256 key from the secret when jwt.symmetric is set, and reuses it on a second call', async () => {
    const runtime = registerAuth({
      secret: SECRET,
      jwt: { issuer: 'https://iss', audience: 'api', symmetric: true },
    });
    const first = await runtime.tokens!.issueAccessToken({ subject: 'u1' });
    const second = await runtime.tokens!.issueAccessToken({ subject: 'u2' });
    expect(typeof first.token).toBe('string');
    expect(first.token.split('.')).toHaveLength(3);
    expect(second.token).not.toBe(first.token);

    // The header segment carries `alg`; decode it directly to confirm HS256.
    const { base64UrlDecodeString } = await import('../src/crypto/base64url.ts');
    const header = JSON.parse(base64UrlDecodeString(first.token.split('.')[0]!));
    expect(header.alg).toBe('HS256');
  });

  it('refuses jwt.symmetric without a secret, at the point a token is actually issued', async () => {
    const runtime = registerAuth({
      csrf: false,
      jwt: { issuer: 'https://iss', audience: 'api', symmetric: true },
    });
    await expect(runtime.tokens!.issueAccessToken({ subject: 'u1' })).rejects.toThrow(
      /requires a `secret`/,
    );
  });

  it('builds a webauthn service when a webauthn config is given', () => {
    const runtime = registerAuth({
      secret: SECRET,
      webauthn: { rpId: 'example.com', rpName: 'Example', origins: ['https://example.com'] },
    });
    expect(runtime.webauthn).toBeDefined();
    expect(useContainer().resolve<WebAuthnService>(AUTH_WEBAUTHN)).toBe(runtime.webauthn!);
  });

  it('uses explicit strategies verbatim instead of composing the defaults', () => {
    const custom: AuthStrategy = { name: 'custom', authenticate: async () => noCredential() };
    const runtime = registerAuth({ secret: SECRET, strategies: [custom] });
    expect(runtime.strategy).toBe(custom);
  });

  it('throws when the supplied container has no registerFactory', () => {
    expect(() => registerAuth({ secret: SECRET, container: {} as AuthContainer })).toThrow(
      /registerFactory/,
    );
  });

  it('Auth() decorator registers a runtime and mixes it onto instances', () => {
    const { Auth } = require('../src/register.ts') as typeof import('../src/register.ts');

    @Auth({ secret: SECRET })
    class AppRoot {}

    const instance = new AppRoot() as unknown as AuthRuntime;
    expect(instance.strategy).toBeDefined();
    expect(instance.strategy).toBe(useContainer().resolve<AuthRuntime>(AUTH_RUNTIME).strategy);
    expect(AppRoot.name).toBe('AppRoot');
  });
});

describe('HTTP guards', () => {
  const buildStrategy = async () => {
    const stores = inMemoryAuthStores();
    const sessions = sessionManager({ store: stores.sessions });
    const issued = await sessions.create({ subject: 'u1' });
    return { strategy: sessionCookieStrategy({ sessions }), token: issued.token };
  };

  it('lets an authenticated request through and attaches the principal', async () => {
    const { strategy, token } = await buildStrategy();
    const request = get(undefined, { cookie: `__Host-sid=${token}` });

    const rejection = await requireAuth({ strategy })(request);
    expect(rejection).toBeUndefined();
    expect(getPrincipal(request)?.sub).toBe('u1');
    expect(isAuthenticated(request)).toBe(true);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const { strategy } = await buildStrategy();
    const response = await requireAuth({ strategy })(get());
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({
      error: 'Authentication required',
      code: 'no_credential',
    } as never);
  });

  it('lets an anonymous request through in optional mode', async () => {
    const { strategy } = await buildStrategy();
    const request = get();
    expect(await optionalAuth({ strategy })(request)).toBeUndefined();
    expect(getPrincipal(request)).toBeUndefined();
  });

  // Optional mode still rejects a credential that was presented and was bad.
  it('rejects a bad credential even in optional mode', async () => {
    const { strategy } = await buildStrategy();
    const response = await optionalAuth({ strategy })(
      get(undefined, { cookie: '__Host-sid=not-a-real-session' }),
    );
    expect(response?.status).toBe(401);
  });

  // `before[]` runs before route matching, so path policy must read pathname.
  it('skips public paths by pathname', async () => {
    const { strategy } = await buildStrategy();
    const guard = requireAuthExcept(['/health', /^\/public\//], { strategy });
    expect(await guard(get('https://app.example.com/health'))).toBeUndefined();
    expect(await guard(get('https://app.example.com/public/logo.png'))).toBeUndefined();
    expect((await guard(get('https://app.example.com/private')))?.status).toBe(401);
  });

  it('resolves the strategy from the DI container when none is given explicitly', async () => {
    const { strategy, token } = await buildStrategy();
    const container = useContainer();
    container.clear();
    try {
      container.registerFactory(AUTH_STRATEGY, () => strategy, { singleton: true });
      const request = get(undefined, { cookie: `__Host-sid=${token}` });
      expect(await requireAuth()(request)).toBeUndefined();
      expect(getPrincipal(request)?.sub).toBe('u1');
    } finally {
      container.clear();
    }
  });

  it('throws a clear error when no strategy is registered under the token', async () => {
    const container = useContainer() as unknown as { resolve?: (token: string) => unknown };
    const original = container.resolve;
    try {
      container.resolve = () => undefined;
      await expect(requireAuth({ strategyToken: 'not.registered' })(get())).rejects.toThrow(
        /No authentication strategy registered/,
      );
    } finally {
      container.resolve = original;
    }
  });

  it('cannot be spoofed through a request body field', async () => {
    const { strategy } = await buildStrategy();
    const request = get();
    // A client posting {"principal": ...} sets req.content.principal, never the
    // symbol the guard reads back.
    (request as unknown as Record<string, unknown>)['principal'] = { sub: 'admin' };
    const response = await requireAuth({ strategy })(request);
    expect(response?.status).toBe(401);
    expect(getPrincipal(request)).toBeUndefined();
  });

  it('throws a renderable error from requirePrincipal', () => {
    expect(() => requirePrincipal(get())).toThrow(AuthError);
  });
});

describe('router integration', () => {
  it('protects a route and types the principal', async () => {
    const stores = inMemoryAuthStores();
    const sessions = sessionManager({ store: stores.sessions });
    const issued = await sessions.create({ subject: 'u1' });
    const strategy = sessionCookieStrategy({ sessions });

    const router = TypedRouter({ catch: withAuthErrors() });
    const secure = withAuthRoutes(router, { strategy });

    secure.get('/me', (request) => Response.json({ sub: request.principal.sub }) as never);
    router.get('/health', () => Response.json({ ok: true }) as never);

    const authed = await router.fetch(
      get('https://app.example.com/me', { cookie: `__Host-sid=${issued.token}` }),
    );
    expect(await authed.json()).toEqual({ sub: 'u1' } as never);

    expect((await router.fetch(get('https://app.example.com/me'))).status).toBe(401);
    expect((await router.fetch(get('https://app.example.com/health'))).status).toBe(200);
  });

  it('honours `auth: false` for a public route on a protected router', async () => {
    const stores = inMemoryAuthStores();
    const strategy = sessionCookieStrategy({
      sessions: sessionManager({ store: stores.sessions }),
    });
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });

    secure.get('/open', () => Response.json({ ok: true }) as never, { auth: false });
    expect((await router.fetch(get('https://app.example.com/open'))).status).toBe(200);
  });

  it('preserves the handler object so @Endpoint and OpenAPI still work', async () => {
    const strategy: AuthStrategy = {
      name: 'stub',
      authenticate: async () => authenticated(createPrincipal({ sub: 'u1', method: 'session' })),
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    const handler = secure.get('/me', () => Response.json({}) as never);

    expect(handler.path).toBe('/me');
    expect(handler.method).toBe('get');
  });

  it('optional() lets an anonymous request through but still types the principal when present', async () => {
    const stores = inMemoryAuthStores();
    const sessions = sessionManager({ store: stores.sessions });
    const issued = await sessions.create({ subject: 'u1' });
    const strategy = sessionCookieStrategy({ sessions });

    const handler = optional(
      (request) => Response.json({ sub: request.principal?.sub ?? null }) as never,
      { strategy },
    );

    const anon = await handler(get() as never);
    expect(await (anon as Response).json()).toEqual({ sub: null } as never);

    const authed = await handler(get(undefined, { cookie: `__Host-sid=${issued.token}` }) as never);
    expect(await (authed as Response).json()).toEqual({ sub: 'u1' } as never);
  });

  it('mountAuthRoutes() delegates a prefix and the bare prefix to the sub-router', async () => {
    // The sub-router strips the mount prefix via itty's own `base` option;
    // mountAuthRoutes only needs to forward both `${prefix}/*` and the bare
    // `${prefix}` to it.
    const sub = TypedRouter({ base: '/auth' });
    sub.get('/ping', () => Response.json({ ok: true }) as never);
    sub.get('/', () => Response.json({ root: true }) as never);

    const main = TypedRouter();
    const mounted = mountAuthRoutes(main, sub, '/auth/');
    expect(mounted).toBe(main);

    const pingResponse = await main.fetch(get('https://app.example.com/auth/ping'));
    expect(pingResponse.status).toBe(200);
    expect(await pingResponse.json()).toEqual({ ok: true } as never);

    const rootResponse = await main.fetch(get('https://app.example.com/auth'));
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.json()).toEqual({ root: true } as never);
  });

  it('runs per-route guards through RouteOptions.use', async () => {
    const strategy: AuthStrategy = { name: 'stub', authenticate: async () => noCredential() };
    const router = TypedRouter();
    router.get('/guarded', () => Response.json({ ok: true }) as never, {
      use: [requireAuth({ strategy })],
    });
    router.get('/open', () => Response.json({ ok: true }) as never);

    expect((await router.fetch(get('https://app.example.com/guarded'))).status).toBe(401);
    expect((await router.fetch(get('https://app.example.com/open'))).status).toBe(200);
  });

  it('protects a bare handler with protect()', async () => {
    const strategy: AuthStrategy = { name: 'stub', authenticate: async () => noCredential() };
    const handler = protect(() => Response.json({ ok: true }) as never, { strategy });
    const response = (await handler(get() as never)) as unknown as Response;
    expect(response.status).toBe(401);
  });
});

describe('response helpers', () => {
  it('stacks multiple Set-Cookie headers', () => {
    // `Headers.set` overwrites and an object literal cannot hold duplicate keys,
    // so `append` onto a rebuilt Headers is the only way.
    const response = withHeaders(new Response('x'), [
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('drains queued headers exactly once', () => {
    const request = get();
    const { queueHeader } = require('../src/http/request.ts');
    queueHeader(request, 'set-cookie', 'a=1');

    const first = applyAuthHeaders(new Response('x'), request) as Response;
    expect(first.headers.getSetCookie()).toEqual(['a=1']);

    // A second finally[] entry must not re-apply.
    const second = applyAuthHeaders(new Response('x'), request) as Response;
    expect(second.headers.getSetCookie()).toEqual([]);
  });

  it('passes through when no route matched', () => {
    expect(applyAuthHeaders(undefined, get())).toBeUndefined();
  });

  it('json() sets the content type and serialises the body', async () => {
    const { json } = await import('../src/http/responses.ts');
    const response = json({ ok: true }, { status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ ok: true } as never);
  });

  it('privateJson() adds Cache-Control: no-store on top of json()', async () => {
    const { privateJson } = await import('../src/http/responses.ts');
    const response = privateJson({ sub: 'u1' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ sub: 'u1' } as never);
  });

  it('redirect() carries multiple Set-Cookie headers, which Response.redirect cannot', async () => {
    const { redirect } = await import('../src/http/responses.ts');
    const response = redirect('/after-login', ['a=1', 'b=2'], 302);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/after-login');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('redirect() defaults to 303 with no cookies', async () => {
    const { redirect } = await import('../src/http/responses.ts');
    const response = redirect('/after-login');
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('error rendering', () => {
  it('renders an AuthError with its challenges and never leaks detail', async () => {
    const handler = withAuthErrors({ log: () => undefined });
    const error = new AuthError('sub claim was "admin", which is reserved', {
      code: 'invalid_token',
      detail: { attemptedSub: 'admin' },
      challenges: ['Bearer realm="api"', 'Basic realm="api"'],
    });

    const response = await handler(error);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('www-authenticate')).toContain('Bearer realm="api"');
    expect(await response.json()).toEqual({
      error: 'Invalid token',
      code: 'invalid_token',
    } as never);
  });

  // itty's `catch` is the only thing between a throw and an unhandled rejection;
  // returning undefined would make fetch() resolve to undefined.
  it('always returns a Response, even for a non-AuthError', async () => {
    const silence = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const handler = withAuthErrors({ log: () => undefined });
      const response = await handler(new Error('boom'));
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(500);
    } finally {
      silence.mockRestore();
    }
  });

  it('exposes UNAUTHENTICATED through extensions for GraphQL', () => {
    expect(new AuthError('x', { code: 'invalid_token' }).extensions).toEqual({
      code: 'UNAUTHENTICATED',
      reason: 'invalid_token',
    });
    expect(new AuthError('x', { code: 'csrf_failed' }).extensions.code).toBe('FORBIDDEN');
  });

  it('logs via console.warn by default when no log option is given', async () => {
    const silence = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const handler = withAuthErrors();
      const response = await handler(
        new AuthError('detail for logs only', { code: 'invalid_token' }),
      );
      expect(response.status).toBe(401);
      expect(silence).toHaveBeenCalledTimes(1);
      expect(silence.mock.calls[0]?.[0]).toContain('invalid_token');
    } finally {
      silence.mockRestore();
    }
  });

  it('authErrorHandler renders an AuthError and defers on anything else', async () => {
    const { authErrorHandler } = await import('../src/http/catch.ts');
    const rendered = authErrorHandler(new AuthError('x', { code: 'invalid_token' }));
    expect(rendered).toBeInstanceOf(Response);
    expect(authErrorHandler(new Error('not ours'))).toBeUndefined();
  });
});

describe('AuthError helpers', () => {
  it('unauthenticated() builds a no_credential error with a default message', () => {
    const error = AuthError.unauthenticated();
    expect(error.code).toBe('no_credential');
    expect(error.message).toBe('No credential presented');
  });

  it('isAuthError() distinguishes AuthError from other errors', async () => {
    const { isAuthError } = await import('../src/errors.ts');
    expect(isAuthError(new AuthError('x'))).toBe(true);
    expect(isAuthError(new Error('x'))).toBe(false);
    expect(isAuthError('x')).toBe(false);
  });

  it('redacted() swaps in the public message but returns itself when already public', () => {
    const error = new AuthError('sensitive detail', {
      code: 'invalid_token',
      challenges: ['Bearer'],
    });
    const safe = error.redacted();
    expect(safe.message).toBe(error.publicMessage);
    expect(safe.cause).toBe(error);
    expect(safe.challenges).toEqual(['Bearer']);

    const alreadyPublic = new AuthError(error.publicMessage, { code: 'invalid_token' });
    expect(alreadyPublic.redacted()).toBe(alreadyPublic);
  });
});

describe('OpenAPI security', () => {
  it('derives security schemes from the strategies in use', () => {
    const strategy = chain([
      { name: 'session', authenticate: async () => noCredential() },
      { name: 'bearer', authenticate: async () => noCredential() },
      { name: 'api-key', authenticate: async () => noCredential() },
    ]);
    const schemes = securitySchemesFor([strategy]);

    expect(schemes['sessionAuth']).toEqual({ type: 'apiKey', in: 'cookie', name: '__Host-sid' });
    expect(schemes['bearerAuth']).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(schemes['apiKeyAuth']).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
  });

  it('adds an openIdConnect scheme when a discovery URL is given', () => {
    const schemes = securitySchemesFor([], {
      openIdConnectUrl: 'https://idp.example.com/.well-known/openid-configuration',
    });
    expect(schemes['openIdConnect']).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://idp.example.com/.well-known/openid-configuration',
    });
  });

  it('emits securitySchemes and a document-level default', () => {
    const spec = generateOpenAPI({
      title: 'API',
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      security: secured('bearerAuth'),
    }) as unknown as Record<string, unknown>;

    expect((spec['components'] as Record<string, unknown>)['securitySchemes']).toBeDefined();
    expect(spec['security']).toEqual([{ bearerAuth: [] }] as never);
  });

  // An empty array is meaningful in OpenAPI — it opts an operation out of the
  // document default — so the generator must test for undefined, not truthiness.
  it('carries an empty per-operation security array through', () => {
    class PublicController {
      static handler = Object.assign(() => new Response(''), {
        isEndpoint: true,
        path: '/public',
        method: 'get',
        metadata: { summary: 'Public', security: publicEndpoint },
      });
    }
    registry.addTarget(PublicController as never);

    const spec = generateOpenAPI({
      title: 'API',
      security: secured('bearerAuth'),
    }) as unknown as Record<string, unknown>;
    const paths = spec['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths['/public']!['get']!;
    expect(operation['security']).toEqual([]);
  });
});
