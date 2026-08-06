import { beforeEach, describe, expect, it } from 'bun:test';
import { type AuthStrategy, authenticated } from '@di-framework/auth';
import { withAuthRoutes } from '@di-framework/auth/http';
import { Controller, TypedRouter } from '@di-framework/http';
import { ResourceAuthorization } from '../http.ts';
import { Allow, Policy, policyRegistry } from '../index.ts';

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
});
