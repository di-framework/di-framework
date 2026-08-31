import { describe, expect, it } from 'bun:test';
import { TypedRouter } from '@di-framework/http';
import { WEBAUTHN_COOKIE_NAME } from '../src/cookies.ts';
import { AuthError } from '../src/errors.ts';
import { withAuthErrors } from '../src/http/catch.ts';
import { createAuthRoutes } from '../src/http/routes.ts';
import type { OAuthClient } from '../src/oauth/client.ts';
import { createPrincipal } from '../src/principal.ts';
import type { AuthRuntime } from '../src/register.ts';
import { registerAuth } from '../src/register.ts';
import { AUTH_RUNTIME } from '../src/tokens.ts';
import type { AuthContainer } from '../src/types.ts';
import type { WebAuthnService } from '../src/webauthn/service.ts';

const SECRET = 'z'.repeat(48);

const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

function cookieHeader(parts: string[]): string {
  return parts.map((setCookie) => setCookie.split(';')[0]!).join('; ');
}

function runtime(overrides: Parameters<typeof registerAuth>[0] = {}): AuthRuntime {
  return registerAuth({
    secret: SECRET,
    jwt: { issuer: 'https://issuer.example', audience: 'api', symmetric: true },
    webauthn: {
      rpId: 'example.com',
      rpName: 'Example',
      origins: ['https://app.example.com'],
    },
    csrf: false,
    ...overrides,
  });
}

describe('createAuthRoutes', () => {
  it('throws when no runtime is registered or passed', () => {
    const container = {
      registerSingletonFactory: () => undefined,
      resolve: (() => undefined) as AuthContainer['resolve'],
    } as AuthContainer;
    expect(() => createAuthRoutes({ container })).toThrow(/No auth runtime registered/);
  });

  it('resolves the runtime from a container when one is registered', async () => {
    const built = runtime({ csrf: false });
    const container = {
      registerSingletonFactory: () => undefined,
      resolve: ((token) =>
        token === AUTH_RUNTIME ? built : undefined) as AuthContainer['resolve'],
    } as AuthContainer;
    const router = createAuthRoutes({
      container,
      enable: { webauthn: false, oauth: false, refresh: false, csrf: false },
    });
    const response = await router.fetch(
      jsonPost('https://app.example.com/register', {
        identifier: 'ada@example.com',
        password: 'correct-horse-battery',
        displayName: 'Ada',
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { principal: { sub: string; method: string } };
    expect(body.principal.sub).toBeDefined();
    expect(body.principal.method).toBe('session');
    expect(response.headers.getSetCookie().some((c) => c.startsWith('__Host-sid='))).toBe(true);
  });

  it('covers register, login (with fixation defence), session, logout, and csrf', async () => {
    const built = runtime({ csrf: {} });
    const router = TypedRouter({ catch: withAuthErrors({ log: () => undefined }) });
    createAuthRoutes({
      runtime: built,
      router,
      enable: { webauthn: false, oauth: false, refresh: false },
      hooks: {
        presentPrincipal: (principal) => ({
          sub: principal.sub,
          method: principal.method,
          amr: principal.amr,
          acr: principal.acr,
          authTime: principal.authTime,
          expiresAt: principal.expiresAt,
        }),
        afterLogin: async () => undefined,
      },
    });

    const registered = await router.fetch(
      jsonPost('https://app.example.com/register', {
        identifier: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );
    expect(registered.status).toBe(200);
    const planted = cookieHeader(registered.headers.getSetCookie());

    const login = await router.fetch(
      jsonPost(
        'https://app.example.com/login',
        { identifier: 'ada@example.com', password: 'correct-horse-battery' },
        { cookie: planted },
      ),
    );
    expect(login.status).toBe(200);
    const sessionCookies = login.headers.getSetCookie();
    expect(sessionCookies.some((c) => c.startsWith('__Host-sid='))).toBe(true);
    expect(sessionCookies.some((c) => c.startsWith('__Host-csrf='))).toBe(true);
    const cookie = cookieHeader(sessionCookies);

    const session = await router.fetch(get('https://app.example.com/session', { cookie }));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      principal: { sub: expect.any(String), method: 'session' },
    });

    const anonSession = await router.fetch(get('https://app.example.com/session'));
    expect((await anonSession.json()) as { principal: null }).toEqual({ principal: null });

    const csrf = await router.fetch(get('https://app.example.com/csrf', { cookie }));
    expect(csrf.status).toBe(200);
    expect(((await csrf.json()) as { token: string }).token.length).toBeGreaterThan(10);

    await expect(
      router.fetch(get('https://app.example.com/csrf')).then(async (r) => {
        if (!r.ok) throw new AuthError(await r.text(), { code: 'no_credential', status: r.status });
      }),
    ).rejects.toBeDefined();

    const logout = await router.fetch(jsonPost('https://app.example.com/logout', {}, { cookie }));
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().some((c) => c.includes('Max-Age=0'))).toBe(true);

    // Idempotent logout without a session.
    expect((await router.fetch(jsonPost('https://app.example.com/logout', {}))).status).toBe(204);
  });

  it('rejects malformed login/register bodies', async () => {
    const router = createAuthRoutes({
      runtime: runtime({ csrf: false }),
      enable: { webauthn: false, oauth: false, refresh: false, csrf: false },
    });
    const catcher = withAuthErrors({ log: () => undefined });
    const wrapped = TypedRouter({ catch: catcher });
    createAuthRoutes({
      runtime: runtime({ csrf: false }),
      router: wrapped,
      enable: { webauthn: false, oauth: false, refresh: false, csrf: false },
    });

    const bad = await wrapped.fetch(jsonPost('https://app.example.com/login', { identifier: 1 }));
    expect(bad.status).toBe(400);

    void router;
  });

  it('rotates refresh tokens into access tokens', async () => {
    const built = runtime({ csrf: false });
    const router = TypedRouter({ catch: withAuthErrors({ log: () => undefined }) });
    createAuthRoutes({
      runtime: built,
      router,
      enable: { webauthn: false, oauth: false, csrf: false },
    });

    const issued = await built.refresh!.issue({ subject: 'u1', amr: ['pwd'] });
    const response = await router.fetch(
      jsonPost('https://app.example.com/refresh', { refreshToken: issued.token }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
      tokenType: string;
      expiresIn: number;
    };
    expect(body.tokenType).toBe('Bearer');
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.refreshToken).not.toBe(issued.token);
  });

  it('covers WebAuthn ceremony routes with a stub service', async () => {
    const built = runtime({ csrf: false });
    const principal = createPrincipal({ sub: 'u1', method: 'webauthn', amr: ['hwk'] });
    const stub: WebAuthnService = {
      generateRegistrationOptions: async () => ({
        challengeKey: 'reg-key',
        expiresAt: 9_999,
        options: {
          challenge: 'c',
          rp: { id: 'example.com', name: 'Example' },
          user: { id: 'h', name: 'u', displayName: 'u' },
          pubKeyCredParams: [],
          timeout: 1,
          excludeCredentials: [],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          attestation: 'none',
        },
      }),
      verifyRegistrationResponse: async () => ({
        credential: {
          kind: 'webauthn',
          id: 'cred-1',
          userId: 'u1',
          publicKeyCose: 'pk',
          algorithm: -7,
          signCount: 0,
          backupEligible: false,
          backupState: false,
          uvInitialized: false,
          createdAt: 0,
          version: 0,
          transports: ['internal'],
        },
        attestation: { fmt: 'none', verified: false, trustPath: 'none' },
        flags: { up: true, uv: false, be: false, bs: false, at: true, ed: false, raw: 0x41 },
      }),
      generateAuthenticationOptions: async () => ({
        challengeKey: 'auth-key',
        expiresAt: 9_999,
        options: { challenge: 'c', rpId: 'example.com', timeout: 1, userVerification: 'preferred' },
      }),
      verifyAuthenticationResponse: async () => ({
        credentialId: 'cred-1',
        userId: 'u1',
        newSignCount: 1,
        signCountSupported: true,
        cloneWarning: false,
        backupStateChanged: false,
        flags: { up: true, uv: true, be: false, bs: false, at: false, ed: false, raw: 0x05 },
        principal,
      }),
    };
    built.webauthn = stub;

    const router = TypedRouter({ catch: withAuthErrors({ log: () => undefined }) });
    createAuthRoutes({
      runtime: built,
      router,
      enable: { oauth: false, refresh: false, csrf: false },
    });

    const regOpts = await router.fetch(
      jsonPost('https://app.example.com/webauthn/register/options', {
        userId: 'u1',
        username: 'ada',
      }),
    );
    expect(regOpts.status).toBe(200);
    expect(
      regOpts.headers.getSetCookie().some((c) => c.startsWith(`${WEBAUTHN_COOKIE_NAME}=`)),
    ).toBe(true);

    const regVerify = await router.fetch(
      jsonPost(
        'https://app.example.com/webauthn/register/verify',
        { id: 'cred-1', response: {} },
        { cookie: `${WEBAUTHN_COOKIE_NAME}=reg-key` },
      ),
    );
    expect(regVerify.status).toBe(201);

    const loginOpts = await router.fetch(
      jsonPost('https://app.example.com/webauthn/login/options', { userId: 'u1' }),
    );
    expect(loginOpts.status).toBe(200);

    const loginOptsDiscoverable = await router.fetch(
      jsonPost('https://app.example.com/webauthn/login/options', {}),
    );
    expect(loginOptsDiscoverable.status).toBe(200);

    const loginVerify = await router.fetch(
      jsonPost(
        'https://app.example.com/webauthn/login/verify',
        { id: 'cred-1', response: {} },
        { cookie: `${WEBAUTHN_COOKIE_NAME}=auth-key` },
      ),
    );
    expect(loginVerify.status).toBe(200);
    expect(loginVerify.headers.getSetCookie().some((c) => c.startsWith('__Host-sid='))).toBe(true);

    const missingCookie = await router.fetch(
      jsonPost('https://app.example.com/webauthn/register/verify', {}),
    );
    expect(missingCookie.status).toBe(400);
  });

  it('covers OAuth start and callback routes', async () => {
    const built = runtime({ csrf: {} });
    const oauth: OAuthClient = {
      authorizationUrl: async ({ returnTo } = {}) => ({
        url: `https://idp.example/authorize?returnTo=${returnTo ?? ''}`,
        stateCookie: '__Host-oauth-state=state; Path=/; Secure; HttpOnly',
        state: 'state',
        nonce: 'nonce',
        codeVerifier: 'verifier',
        expiresAt: 9_999,
      }),
      callback: async () => ({
        tokens: {
          accessToken: 'a',
          tokenType: 'Bearer',
          expiresIn: 3600,
        },
        profile: {
          subject: 'google-sub',
          issuer: 'https://idp.example',
          email: 'ada@example.com',
          raw: { sub: 'google-sub', email: 'ada@example.com' },
        },
        principal: createPrincipal({ sub: 'google-sub', method: 'oauth', amr: ['oauth'] }),
        returnTo: '/welcome',
        clearStateCookie: '__Host-oauth-state=; Max-Age=0',
      }),
      refresh: async () => ({ accessToken: 'a', tokenType: 'Bearer', expiresIn: 1 }),
      userinfo: async () => ({}),
      endSessionUrl: async () => null,
      metadata: async () => null,
    };

    const router = TypedRouter({ catch: withAuthErrors({ log: () => undefined }) });
    createAuthRoutes({
      runtime: built,
      router,
      oauth: { google: oauth },
      enable: { webauthn: false, refresh: false },
      hooks: {
        afterLogin: async () => undefined,
        oauthRedirect: (_principal, returnTo) => returnTo ?? '/fallback',
      },
    });

    const start = await router.fetch(
      get('https://app.example.com/oauth/google/start?returnTo=%2Fapp'),
    );
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('idp.example');

    const unknown = await router.fetch(get('https://app.example.com/oauth/unknown/start'));
    expect(unknown.status).toBe(404);

    const callback = await router.fetch(
      get('https://app.example.com/oauth/google/callback?code=x&state=y'),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/welcome');
    expect(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-sid='))).toBe(true);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-csrf='))).toBe(true);

    const unknownCb = await router.fetch(get('https://app.example.com/oauth/noop/callback'));
    expect(unknownCb.status).toBe(404);
  });

  it('skips disabled feature routes and default principal projection', async () => {
    const built = runtime({ csrf: false });
    const issued = await built.sessions.create({
      subject: 'u1',
      amr: ['pwd'],
      acr: '1',
    });
    const router = createAuthRoutes({
      runtime: built,
      enable: {
        register: false,
        login: false,
        logout: false,
        refresh: false,
        csrf: false,
        webauthn: false,
        oauth: false,
      },
    });

    const session = await router.fetch(
      get('https://app.example.com/session', {
        cookie: `__Host-sid=${issued.token}`,
      }),
    );
    expect(await session.json()).toMatchObject({
      principal: { sub: 'u1', amr: ['pwd'], acr: '1', expiresAt: expect.any(Number) },
    });

    expect(await router.fetch(jsonPost('https://app.example.com/login', {}))).toBeUndefined();
  });

  it('covers CSRF rejection when the session is not active', async () => {
    const built = runtime({ csrf: {} });
    const router = TypedRouter({ catch: withAuthErrors({ log: () => undefined }) });
    createAuthRoutes({
      runtime: built,
      router,
      enable: { webauthn: false, oauth: false, refresh: false, register: false, login: false },
    });

    const csrf = await router.fetch(
      get('https://app.example.com/csrf', { cookie: '__Host-sid=not-a-real-session' }),
    );
    expect(csrf.status).toBe(401);
  });
});
