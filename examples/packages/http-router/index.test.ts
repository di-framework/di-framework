import { describe, expect, test } from 'bun:test';
import defaultExport, { router } from './index';

// A tiny helper to create Requests with JSON
function jsonReq(url: string, method: string, body?: any) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

import { useContainer } from '@di-framework/core';
import { EchoController } from './index';

describe('http-router example', () => {
  // Prime the container to ensure controller is registered in the same instance
  const c = useContainer();
  if (!c.has(EchoController)) {
    // Re-import side effect is enough; but keep a sanity access
    void EchoController;
  }
  test('GET / returns health', async () => {
    const res = await defaultExport.fetch(new Request('http://localhost/'), {}, {} as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(body).toEqual({ message: 'API is healthy' });
  });

  test('POST /echo echoes message with timestamp', async () => {
    const { LoggerService } = await import('@di-framework/services-example/LoggerService');
    const container = useContainer();
    if (!container.has(LoggerService)) container.register(LoggerService, { singleton: true });
    if (!container.has(EchoController)) container.register(EchoController, { singleton: true });

    const res = await router.fetch(jsonReq('/echo', 'POST', { message: 'hello' }), {}, {} as any);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.echoed).toBe('hello');
    expect(typeof body.timestamp).toBe('string');
  });

  test('GET /static/style.css serves mounted static CSS asset with cache headers', async () => {
    const res = await defaultExport.fetch(
      new Request('http://localhost/static/style.css'),
      {},
      {} as any,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('etag')).toBeDefined();
    const cssText = await res.text();
    expect(cssText).toContain('font-family: sans-serif');
  });

  test('GET /static/logo.svg serves static SVG asset', async () => {
    const res = await defaultExport.fetch(
      new Request('http://localhost/static/logo.svg'),
      {},
      {} as any,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    const svgText = await res.text();
    expect(svgText).toContain('<svg');
  });

  test('HEAD /static/info.json returns headers without body', async () => {
    const res = await defaultExport.fetch(
      new Request('http://localhost/static/info.json', { method: 'HEAD' }),
      {},
      {} as any,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  test('conditional GET with matching ETag returns 304 Not Modified', async () => {
    const firstRes = await defaultExport.fetch(
      new Request('http://localhost/static/style.css'),
      {},
      {} as any,
    );
    const etag = firstRes.headers.get('etag')!;

    const conditionalRes = await defaultExport.fetch(
      new Request('http://localhost/static/style.css', {
        headers: { 'if-none-match': etag },
      }),
      {},
      {} as any,
    );
    expect(conditionalRes.status).toBe(304);
    expect(conditionalRes.headers.get('etag')).toBe(etag);
  });
});
