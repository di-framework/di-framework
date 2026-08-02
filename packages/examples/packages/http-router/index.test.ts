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

import { useContainer } from '@di-framework/di-framework/container';
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
    const { LoggerService } = await import('../services/LoggerService');
    const container = useContainer();
    if (!container.has(LoggerService)) container.register(LoggerService, { singleton: true });
    if (!container.has(EchoController)) container.register(EchoController, { singleton: true });

    const res = await router.fetch(jsonReq('/echo', 'POST', { message: 'hello' }), {}, {} as any);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.echoed).toBe('hello');
    expect(typeof body.timestamp).toBe('string');
  });
});
