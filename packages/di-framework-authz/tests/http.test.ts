import { beforeEach, describe, expect, it } from 'bun:test';
import { type AuthStrategy, authenticated, noCredential } from '@di-framework/auth';
import { withAuthRoutes } from '@di-framework/auth/http';
import { Controller, TypedRouter } from '@di-framework/http';
import { ResourceAction, ResourceAuthorization } from '../http.ts';
import {
  Allow,
  Deny,
  Equals,
  Owner,
  Policy,
  policyAuthorizationManager,
  policyRegistry,
} from '../index.ts';

describe('HTTP resource authorization', () => {
  beforeEach(() => policyRegistry.clear());
  it('binds direct static routes, infers actions, and runs after authentication', async () => {
    class DocumentPolicy {
      @Allow('read') read() {}
    }
    Policy('document')(DocumentPolicy);
    const strategy: AuthStrategy = {
      name: 'test',
      authenticate: async () => authenticated({ sub: 'u1', method: 'bearer', authTime: 1 }),
    };
    const calls: unknown[] = [];
    const manager = {
      authorize: (principal: unknown, context: unknown) => {
        calls.push([principal, context]);
        return { allowed: true as const };
      },
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    class Documents {
      static read = secure.get('/documents/:id', () => Response.json({ ok: true }) as never);
    }
    Controller()(Documents);
    ResourceAuthorization(DocumentPolicy, { manager })(Documents);
    const response = await router.fetch(new Request('https://example.test/documents/d1'));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0] as any)[1].metadata).toMatchObject({
      resource: 'document',
      action: 'read',
      idParam: 'id',
    });
  });
  it('fails closed for decorator order and plain routes', () => {
    class P {
      @Allow('read') read() {}
    }
    Policy('x')(P);
    class Reversed {}
    expect(() => ResourceAuthorization(P)(Reversed)).toThrow(/stacked above/);
    const router = TypedRouter();
    class Plain {
      static read = router.get('/x/:id', () => new Response() as never);
    }
    Controller()(Plain);
    expect(() => ResourceAuthorization(P)(Plain)).toThrow(/withAuthRoutes/);
  });
  it('rejects route-level authorization, including false', () => {
    class P {
      @Allow('read') read() {}
    }
    Policy('x')(P);
    const strategy: AuthStrategy = {
      name: 'test',
      authenticate: async () => authenticated({ sub: 'u1', method: 'bearer', authTime: 1 }),
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    class C {
      static read = secure.get('/x/:id', () => new Response() as never, { authorization: false });
    }
    Controller()(C);
    expect(() => ResourceAuthorization(P)(C)).toThrow(/conflicts/);
  });

  it('validates explicit actions and policy references', () => {
    expect(() => ResourceAction('')).toThrow(/Unknown resource action/);
    expect(() => ResourceAction('not valid')).toThrow(/Unknown resource action/);
    expect(() => ResourceAction('archive')({ route: 1 }, 'route')).toThrow(/initialized static/);

    class MissingPolicy {}
    class MissingController {}
    Controller()(MissingController);
    expect(() => ResourceAuthorization(MissingPolicy)(MissingController)).toThrow(/not registered/);
  });

  it('rejects routes whose action cannot be inferred', () => {
    class P {
      @Allow('create') create() {}
    }
    Policy('x')(P);
    const strategy: AuthStrategy = {
      name: 'test',
      authenticate: async () => authenticated({ sub: 'u1', method: 'bearer', authTime: 1 }),
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    class C {
      static create = secure.post('/x/:id', () => new Response() as never);
    }
    Controller()(C);
    expect(() => ResourceAuthorization(P)(C)).toThrow(/Cannot infer a resource action/);
  });

  it('enforces real policies and redacts every deny path', async () => {
    class DocumentPolicy {
      @Allow('read') @Owner() owner() {}
      @Deny('read') @Equals('resource.locked', true) locked() {}
    }
    Policy('document')(DocumentPolicy);

    const records: Record<string, { ownerId: string; locked: boolean }> = {
      owned: { ownerId: 'u1', locked: false },
      locked: { ownerId: 'u1', locked: true },
      other: { ownerId: 'u2', locked: false },
    };
    const manager = policyAuthorizationManager({
      providers: { document: { load: async (id) => records[id] } },
    });
    const strategy: AuthStrategy = {
      name: 'test',
      authenticate: async () => authenticated({ sub: 'u1', method: 'bearer', authTime: 1 }),
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    class Documents {
      static read = secure.get('/documents/:id', () => Response.json({ ok: true }) as never);
    }
    Controller()(Documents);
    ResourceAuthorization(DocumentPolicy, { manager })(Documents);

    const owned = await router.fetch(new Request('https://example.test/documents/owned'));
    expect(owned.status).toBe(200);

    for (const id of ['locked', 'other', 'missing']) {
      const denied = await router.fetch(new Request(`https://example.test/documents/${id}`));
      expect(denied.status).toBe(403);
      expect((await denied.json()) as { error: string; code: string }).toEqual({
        error: 'Access denied',
        code: 'access_denied',
      });
    }

    const invoke = Documents.read as unknown as (request: Request) => Promise<Response>;
    const missingId = await invoke(new Request('https://example.test/documents'));
    expect(missingId.status).toBe(403);
    expect((await missingId.json()) as { error: string; code: string }).toEqual({
      error: 'Access denied',
      code: 'access_denied',
    });
  });

  it('rejects unauthenticated requests before invoking a permissive manager', async () => {
    class DocumentPolicy {
      @Allow('read') read() {}
    }
    Policy('document')(DocumentPolicy);
    const strategy: AuthStrategy = {
      name: 'anonymous',
      authenticate: async () => noCredential(),
    };
    let calls = 0;
    const manager = {
      authorize: () => {
        calls++;
        return { allowed: true as const };
      },
    };
    const router = TypedRouter();
    const secure = withAuthRoutes(router, { strategy });
    class Documents {
      static read = secure.get('/documents/:id', () => Response.json({ ok: true }) as never);
    }
    Controller()(Documents);
    ResourceAuthorization(DocumentPolicy, { manager })(Documents);

    const response = await router.fetch(new Request('https://example.test/documents/d1'));
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });
});
