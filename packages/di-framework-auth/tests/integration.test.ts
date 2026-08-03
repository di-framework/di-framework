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
import { protect, withAuthRoutes } from '../src/http/router.ts';
import { createPrincipal } from '../src/principal.ts';
import {
  inMemoryAuthStores,
  memoryCredentialStore,
  memorySessionStore,
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
import { AUTH_RUNTIME, AUTH_SESSIONS, AUTH_STRATEGY } from '../src/tokens.ts';
import type { AuthStrategy } from '../src/types.ts';

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
