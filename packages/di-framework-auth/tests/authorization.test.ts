import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { TypedRouter } from '@di-framework/http';
import {
  type AuthorizationManager,
  authorizationAllowed,
  authorizationDenied,
  resolveAuthorizationManager,
} from '../src/authorization.ts';
import { authorize, requireAuthz, runAuthorizationGuard } from '../src/http/authorization.ts';
import { getPrincipal, setPrincipal } from '../src/http/request.ts';
import { DEFERRED_AUTHORIZATION, withAuthRoutes } from '../src/http/router.ts';
import { createPrincipal } from '../src/principal.ts';
import { registerAuth } from '../src/register.ts';
import { authenticated } from '../src/result.ts';
import { AUTHORIZATION_MANAGER } from '../src/tokens.ts';
import type { AuthStrategy } from '../src/types.ts';

const principal = createPrincipal({ sub: 'u1', method: 'session' });
const request = () => new Request('https://app.example.com/admin');

describe('authorization registration', () => {
  beforeEach(() => useContainer().clear());

  it('registers the manager in the runtime and under the default DI token', () => {
    const manager: AuthorizationManager = { authorize: () => authorizationAllowed() };
    const runtime = registerAuth({ csrf: false, authorization: manager });
    expect(runtime.authorization).toBe(manager);
    expect(useContainer().resolve<AuthorizationManager>(AUTHORIZATION_MANAGER)).toBe(manager);
  });
});

describe('HTTP authorization', () => {
  beforeEach(() => useContainer().clear());

  it('passes the principal and opaque metadata to an allowing manager', async () => {
    const seen: unknown[] = [];
    const manager: AuthorizationManager = {
      authorize(received, context) {
        seen.push(received, context);
        return authorizationAllowed();
      },
    };
    const req = request();
    setPrincipal(req, principal);

    expect(
      await runAuthorizationGuard(req, { manager, metadata: { action: 'admin:read' } }),
    ).toBeUndefined();
    expect(seen[0]).toBe(principal);
    expect(seen[1]).toMatchObject({
      transport: 'http',
      request: req,
      metadata: { action: 'admin:read' },
    });
  });

  it('returns a generic 403 without leaking the manager reason', async () => {
    const req = request();
    setPrincipal(req, principal);
    const response = await requireAuthz({
      manager: { authorize: () => authorizationDenied('OPA rule finance.admin failed') },
    })(req);

    expect(response?.status).toBe(403);
    if (!response) throw new Error('expected authorization rejection');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'Access denied', code: 'access_denied' });
    expect(body).not.toContain('finance.admin');
  });

  it('requires a principal by default and can explicitly evaluate anonymous requests', async () => {
    let anonymous: unknown = 'not-called';
    const manager: AuthorizationManager = {
      authorize(received) {
        anonymous = received;
        return authorizationAllowed();
      },
    };

    expect((await requireAuthz({ manager })(request()))?.status).toBe(401);
    expect(anonymous).toBe('not-called');
    expect(await requireAuthz({ manager, allowAnonymous: true })(request())).toBeUndefined();
    expect(anonymous).toBeUndefined();
  });

  it('fails clearly when no manager is registered', async () => {
    const req = request();
    setPrincipal(req, principal);
    await expect(runAuthorizationGuard(req)).rejects.toThrow(/No authorization manager registered/);
  });

  it('supports a direct per-call manager override on a wrapped handler', async () => {
    const req = request();
    setPrincipal(req, principal);
    const handler = authorize(() => Response.json({ ok: true }) as never, {
      manager: { authorize: () => authorizationAllowed() },
    });
    const response = (await handler(req as never)) as unknown as Response;
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('runs after authentication through withAuthRoutes()', async () => {
    const strategy: AuthStrategy = {
      name: 'stub',
      authenticate: async () => authenticated(principal),
    };
    const manager: AuthorizationManager = {
      authorize: (received) =>
        received?.sub === 'u1' ? authorizationAllowed() : authorizationDenied(),
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    secure.get('/admin', (req) => Response.json({ sub: req.principal.sub }) as never, {
      authorization: { manager, metadata: { action: 'admin:read' } },
    });

    const req = request();
    const response = await router.fetch(req);
    expect(response.status).toBe(200);
    expect((await response.json()) as { sub: string }).toEqual({ sub: 'u1' });
    expect(getPrincipal(req)?.sub).toBe('u1');
  });

  it('resolves a registered authorization manager directly from container', () => {
    const manager: AuthorizationManager = { authorize: () => authorizationAllowed() };
    registerAuth({ csrf: false, authorization: manager });
    expect(resolveAuthorizationManager({ container: useContainer() as any })).toBe(manager);
    useContainer().clear();
  });

  it('covers deferred authorization binding branches on routes', async () => {
    const router = TypedRouter();
    const secure = withAuthRoutes(router, {
      strategy: { name: 'stub', authenticate: async () => authenticated(principal) },
    });
    const handler = secure.get('/deferred', (req) => Response.json({ ok: true }) as never);

    const bindFn = (handler as any)[DEFERRED_AUTHORIZATION];
    expect(bindFn).toBeFunction();

    // Bind deferred authorization guard
    bindFn({
      manager: { authorize: () => authorizationDenied('deferred deny') },
    });

    // Test rejection when deferred authorization runs
    const response = await router.fetch(new Request('https://app.example.com/deferred'));
    expect(response.status).toBe(403);

    // Test error when binding second time
    expect(() => bindFn({ manager: { authorize: () => authorizationAllowed() } })).toThrow(
      /already bound/,
    );

    // Test error when binding on a route with route-level authorization
    const router2 = TypedRouter();
    const secure2 = withAuthRoutes(router2);
    const handler2 = secure2.get('/conflict', () => Response.json({ ok: true }) as never, {
      authorization: { manager: { authorize: () => authorizationAllowed() } },
    });
    const bindFn2 = (handler2 as any)[DEFERRED_AUTHORIZATION];
    expect(() => bindFn2({ manager: { authorize: () => authorizationAllowed() } })).toThrow(
      /conflicts with deferred authorization/,
    );
  });
});
