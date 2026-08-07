import { afterEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { HttpRouter, HttpRouterBuilder, json, registry, TypedRouter } from '../index.ts';

describe('HttpRouter Builder & @HttpRouter Decorator', () => {
  afterEach(() => {
    registry.clear();
  });
  it('preserves TypedRouter as low-level backward-compatible factory', async () => {
    const router = TypedRouter();
    router.get('/ping', () => json({ status: 'pong' }));

    const res = await router.fetch(new Request('https://example.com/ping'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('pong');
  });

  it('builds a router with path prefix, global middleware, and catch handler', async () => {
    let middlewareRan = false;

    const http = HttpRouter.builder()
      .prefix('/api/v1')
      .use((req) => {
        middlewareRan = true;
        (req as any).customHeader = 'tracked';
      })
      .catch((err) => new Response(JSON.stringify({ error: err.message }), { status: 500 }))
      .build();

    http.get('/health', (req) => {
      expect((req as any).customHeader).toBe('tracked');
      return json({ status: 'healthy' });
    });

    http.get('/error', () => {
      throw new Error('Boom!');
    });

    // 1. Prefixed route call
    const res = await http.fetch(new Request('https://example.com/api/v1/health'));
    expect(res.status).toBe(200);
    expect(middlewareRan).toBeTrue();

    // 2. Catch handler call
    const errRes = await http.fetch(new Request('https://example.com/api/v1/error'));
    expect(errRes.status).toBe(500);
    const errBody: any = await errRes.json();
    expect(errBody.error).toBe('Boom!');
  });

  it('supports custom builder extensions via .extend()', async () => {
    let extended = false;

    const http = HttpRouter.builder()
      .extend((builder, router) => {
        extended = true;
        (router as any).customFacet = { ok: true };
      })
      .build();

    expect(extended).toBeTrue();
    expect((http as any).customFacet).toEqual({ ok: true });
    expect(http.router).toBeDefined();
  });

  it('supports auth extension registration and withAuth() option', async () => {
    let extensionCalled = false;

    HttpRouter.registerAuthExtension((builder, router) => {
      extensionCalled = true;
      router.secure = { authenticated: true };
    });

    const http = HttpRouter.builder().withAuth().build();

    expect(extensionCalled).toBeTrue();
    expect(http.secure).toEqual({ authenticated: true });
  });

  it('works with @HttpRouter decorator and DI container resolution', async () => {
    @HttpRouter({
      prefix: '/app',
    })
    class AppRouter {}

    const routerFromTarget = HttpRouter.getRouter(AppRouter);
    expect(routerFromTarget).toBeDefined();
    expect(routerFromTarget?.prefixPath).toBe('/app');

    const container = useContainer();
    if (container && typeof container.resolve === 'function') {
      const resolvedRouter = container.resolve('HTTP_ROUTER');
      expect(resolvedRouter).toBeDefined();
    }
  });
});
