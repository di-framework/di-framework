import { useContainer } from '@di-framework/core/container';
import { TypedRouter, type TypedRouterType } from '@di-framework/http';
import {
  type CookieAttributes,
  clearCookie,
  OAUTH_STATE_COOKIE_NAME,
  readCookie,
  SESSION_COOKIE_NAME,
  serializeCookie,
  WEBAUTHN_COOKIE_NAME,
} from '../cookies.ts';
import { AuthError } from '../errors.ts';
import type { OAuthClient } from '../oauth/client.ts';
import type { Principal } from '../principal.ts';
import type { AuthRuntime } from '../register.ts';
import { AUTH_RUNTIME } from '../tokens.ts';
import type { AuthContainer } from '../types.ts';
import { runGuard } from './middleware.ts';
import { getPrincipal } from './request.ts';
import { privateJson, redirect } from './responses.ts';

/**
 * A mountable router for the protocol endpoints.
 *
 * `/auth/login` is not a domain endpoint, it is a protocol endpoint, and the
 * parts people get wrong are identical in every application: the `__Host-`
 * cookie attributes, regenerating the session id on login, double-submit CSRF,
 * the PKCE verifier lifecycle, single-use `state`, and binding a WebAuthn
 * challenge to its ceremony. Shipping strategies but making you hand-write the
 * login endpoint would be shipping the easy half.
 *
 * The obvious objection is that a router appearing by import is a side effect,
 * and that its endpoints would silently pollute a generated OpenAPI document.
 * Hence: this is a function you call and mount, never a module side effect; it
 * registers nothing globally; and every response is shaped by `hooks`.
 */

export interface AuthRoutesOptions {
  /** Defaults to the runtime registered by `registerAuth()`. */
  runtime?: AuthRuntime;
  container?: AuthContainer;
  /** Router to attach to. A fresh one is created when omitted. */
  router?: TypedRouterType;
  cookie?: CookieAttributes;
  cookieName?: string;
  /** OAuth clients keyed by provider id, for the `/oauth/:provider` routes. */
  oauth?: Readonly<Record<string, OAuthClient>>;
  enable?: Partial<
    Record<
      'register' | 'login' | 'logout' | 'refresh' | 'session' | 'csrf' | 'webauthn' | 'oauth',
      boolean
    >
  >;
  hooks?: {
    /** Shapes `/session`. Defaults to a minimal projection — never the raw claims. */
    presentPrincipal?: (principal: Principal) => unknown;
    afterLogin?: (principal: Principal, request: Request) => void | Promise<void>;
    /** Where `/oauth/:provider/callback` redirects on success. Default `'/'`. */
    oauthRedirect?: (principal: Principal, returnTo?: string) => string;
  };
}

interface LoginBody {
  identifier?: unknown;
  password?: unknown;
}

interface RegisterBody extends LoginBody {
  displayName?: unknown;
}

function resolveRuntime(options: AuthRoutesOptions): AuthRuntime {
  if (options.runtime) return options.runtime;
  const container = options.container ?? (useContainer() as unknown as AuthContainer);
  const runtime = container.resolve?.<AuthRuntime>(AUTH_RUNTIME);
  if (!runtime) {
    throw new Error(
      `No auth runtime registered under '${AUTH_RUNTIME}'. Call registerAuth() before ` +
        'createAuthRoutes(), or pass { runtime }.',
    );
  }
  return runtime;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthError(`Field '${field}' is required`, {
      code: 'malformed_credential',
      status: 400,
      publicMessage: `Field '${field}' is required`,
    });
  }
  return value;
}

const defaultPresent = (principal: Principal): unknown => ({
  sub: principal.sub,
  method: principal.method,
  authTime: principal.authTime,
  ...(principal.amr ? { amr: principal.amr } : {}),
  ...(principal.acr ? { acr: principal.acr } : {}),
  ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
  // Deliberately no `claims`: whatever an identity provider chose to put in a
  // token is not automatically safe to echo back to the browser.
});

export function createAuthRoutes(options: AuthRoutesOptions = {}): TypedRouterType {
  const runtime = resolveRuntime(options);
  const router = options.router ?? TypedRouter();
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  const cookieAttributes: CookieAttributes = { ...runtime.cookie, ...options.cookie };
  const enable = options.enable ?? {};
  const present = options.hooks?.presentPrincipal ?? defaultPresent;
  const on = (feature: keyof NonNullable<AuthRoutesOptions['enable']>): boolean =>
    enable[feature] !== false;

  const sessionCookie = (token: string): string =>
    serializeCookie(cookieName, token, {
      ...cookieAttributes,
      maxAge: runtime.sessions.policy.absoluteTimeoutSeconds,
    });

  const issueSession = async (principal: Principal, request: Request): Promise<Response> => {
    const issued = await runtime.sessions.create({
      subject: principal.sub,
      authTime: principal.authTime,
      ...(principal.amr ? { amr: principal.amr } : {}),
      ...(principal.acr ? { acr: principal.acr } : {}),
    });

    const cookies = [sessionCookie(issued.token)];
    if (runtime.csrf) {
      // Readable by client script by design — the double-submit pattern needs the
      // page to echo it into a header. Its security comes from the HMAC binding
      // it to this session, not from being hidden.
      cookies.push(
        serializeCookie('__Host-csrf', await runtime.csrf.issue(issued.record.id), {
          ...cookieAttributes,
          httpOnly: false,
          maxAge: runtime.sessions.policy.absoluteTimeoutSeconds,
        }),
      );
    }

    await options.hooks?.afterLogin?.(issued.principal, request);

    const response = privateJson({ principal: present(issued.principal) }, { status: 200 });
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(response.body, { status: response.status, headers });
  };

  if (on('register')) {
    router.post('/register', async (request) => {
      const body = ((request as { content?: unknown }).content ?? {}) as RegisterBody;
      const user = await runtime.passwords.createUser({
        identifier: readString(body.identifier, 'identifier'),
        password: readString(body.password, 'password'),
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      });
      const { principal } = await runtime.passwords.login(
        user.identifier,
        readString(body.password, 'password'),
      );
      return issueSession(principal, request as unknown as Request);
    });
  }

  if (on('login')) {
    router.post('/login', async (request) => {
      const body = ((request as { content?: unknown }).content ?? {}) as LoginBody;
      const { principal } = await runtime.passwords.login(
        readString(body.identifier, 'identifier'),
        readString(body.password, 'password'),
      );

      // A brand-new session id, never a reuse of whatever the client already
      // held. That is the session-fixation defence: an id an attacker planted
      // before authentication must not survive it.
      const existing = readCookie(request as unknown as Request, cookieName);
      if (existing) await runtime.sessions.revoke(existing);

      return issueSession(principal, request as unknown as Request);
    });
  }

  if (on('logout')) {
    router.post('/logout', async (request) => {
      const token = readCookie(request as unknown as Request, cookieName);
      // Idempotent: logging out twice, or without a session, is a 204 either way.
      if (token) await runtime.sessions.revoke(token);

      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', clearCookie(cookieName, cookieAttributes));
      headers.append(
        'set-cookie',
        clearCookie('__Host-csrf', { ...cookieAttributes, httpOnly: false }),
      );
      return new Response(null, { status: 204, headers });
    });
  }

  if (on('session')) {
    router.get('/session', async (request) => {
      const rejection = await runGuard(request as unknown as Request, {
        mode: 'optional',
        strategy: runtime.strategy,
      });
      if (rejection) return rejection;
      const principal = getPrincipal(request);
      return privateJson(principal ? { principal: present(principal) } : { principal: null });
    });
  }

  if (on('csrf') && runtime.csrf) {
    router.get('/csrf', async (request) => {
      const token = readCookie(request as unknown as Request, cookieName);
      if (!token) throw AuthError.unauthenticated('CSRF tokens are bound to a session');
      const lookup = await runtime.sessions.resolve(token);
      if (lookup.state !== 'active') throw AuthError.unauthenticated('Session is not active');
      return privateJson({ token: await runtime.csrf?.issue(lookup.record.id) });
    });
  }

  if (on('refresh') && runtime.refresh && runtime.tokens) {
    router.post('/refresh', async (request) => {
      const body = ((request as { content?: unknown }).content ?? {}) as { refreshToken?: unknown };
      const rotated = await runtime.refresh?.rotate(readString(body.refreshToken, 'refreshToken'));
      const access = await runtime.tokens?.issueAccessToken({
        subject: rotated.principal.sub,
        authTime: rotated.principal.authTime,
        ...(rotated.principal.amr ? { amr: rotated.principal.amr } : {}),
      });
      return privateJson({
        accessToken: access.token,
        expiresIn: access.expiresIn,
        refreshToken: rotated.token,
        tokenType: 'Bearer',
      });
    });
  }

  if (on('webauthn') && runtime.webauthn) {
    const webauthn = runtime.webauthn;
    const challengeCookie = (key: string, maxAge: number): string =>
      serializeCookie(WEBAUTHN_COOKIE_NAME, key, { ...cookieAttributes, maxAge });

    const readChallengeKey = (request: Request): string => {
      const key = readCookie(request, WEBAUTHN_COOKIE_NAME);
      if (!key) {
        throw new AuthError('WebAuthn ceremony cookie is missing', {
          code: 'challenge_not_found',
          status: 400,
        });
      }
      return key;
    };

    router.post('/webauthn/register/options', async (request) => {
      const principal = getPrincipal(request) ?? undefined;
      const body = ((request as { content?: unknown }).content ?? {}) as {
        userId?: unknown;
        username?: unknown;
      };
      const userId = principal?.sub ?? readString(body.userId, 'userId');
      const ceremony = await webauthn.generateRegistrationOptions({
        userId,
        username: typeof body.username === 'string' ? body.username : userId,
      });
      const response = privateJson(ceremony.options);
      const headers = new Headers(response.headers);
      headers.append('set-cookie', challengeCookie(ceremony.challengeKey, 300));
      return new Response(response.body, { status: 200, headers });
    });

    router.post('/webauthn/register/verify', async (request) => {
      const challengeKey = readChallengeKey(request as unknown as Request);
      const body = (request as { content?: unknown }).content as never;
      const verified = await webauthn.verifyRegistrationResponse(body, { challengeKey });
      await runtime.stores.credentials.saveWebAuthn(verified.credential);

      const response = privateJson(
        {
          credentialId: verified.credential.id,
          attestation: verified.attestation,
        },
        { status: 201 },
      );
      const headers = new Headers(response.headers);
      headers.append('set-cookie', clearCookie(WEBAUTHN_COOKIE_NAME, cookieAttributes));
      return new Response(response.body, { status: 201, headers });
    });

    router.post('/webauthn/login/options', async (request) => {
      const body = ((request as { content?: unknown }).content ?? {}) as { userId?: unknown };
      const ceremony = await webauthn.generateAuthenticationOptions(
        typeof body.userId === 'string' ? { userId: body.userId } : {},
      );
      const response = privateJson(ceremony.options);
      const headers = new Headers(response.headers);
      headers.append('set-cookie', challengeCookie(ceremony.challengeKey, 300));
      return new Response(response.body, { status: 200, headers });
    });

    router.post('/webauthn/login/verify', async (request) => {
      const challengeKey = readChallengeKey(request as unknown as Request);
      const body = (request as { content?: unknown }).content as never;
      const verified = await webauthn.verifyAuthenticationResponse(body, { challengeKey });

      const sessionResponse = await issueSession(verified.principal, request as unknown as Request);
      const headers = new Headers(sessionResponse.headers);
      headers.append('set-cookie', clearCookie(WEBAUTHN_COOKIE_NAME, cookieAttributes));
      return new Response(sessionResponse.body, { status: sessionResponse.status, headers });
    });
  }

  if (on('oauth') && options.oauth) {
    const clients = options.oauth;

    router.get('/oauth/:provider/start', async (request) => {
      const providerId = (request as { params?: Record<string, string> }).params?.provider ?? '';
      const client = clients[providerId];
      if (!client) {
        throw new AuthError(`No OAuth provider '${providerId}'`, {
          code: 'oauth_error',
          status: 404,
          publicMessage: 'Unknown sign-in provider',
        });
      }
      const url = new URL((request as unknown as Request).url);
      const returnTo = url.searchParams.get('returnTo');
      const authorization = await client.authorizationUrl(returnTo ? { returnTo } : {});
      return redirect(authorization.url, [authorization.stateCookie], 302);
    });

    router.get('/oauth/:provider/callback', async (request) => {
      const providerId = (request as { params?: Record<string, string> }).params?.provider ?? '';
      const client = clients[providerId];
      if (!client) {
        throw new AuthError(`No OAuth provider '${providerId}'`, {
          code: 'oauth_error',
          status: 404,
          publicMessage: 'Unknown sign-in provider',
        });
      }

      const result = await client.callback(request as unknown as Request);
      const issued = await runtime.sessions.create({
        subject: `${providerId}:${result.profile.subject}`,
        authTime: result.principal.authTime,
        ...(result.principal.amr ? { amr: result.principal.amr } : {}),
      });
      await options.hooks?.afterLogin?.(issued.principal, request as unknown as Request);

      const target =
        options.hooks?.oauthRedirect?.(issued.principal, result.returnTo) ?? result.returnTo ?? '/';
      const cookies = [sessionCookie(issued.token), result.clearStateCookie];
      if (runtime.csrf) {
        cookies.push(
          serializeCookie('__Host-csrf', await runtime.csrf.issue(issued.record.id), {
            ...cookieAttributes,
            httpOnly: false,
            maxAge: runtime.sessions.policy.absoluteTimeoutSeconds,
          }),
        );
      }
      return redirect(target, cookies);
    });
  }

  return router;
}

export { OAUTH_STATE_COOKIE_NAME };
