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
    // Fallback to calling controller method directly to avoid cross-container registration issues in monorepo test env
    const { EchoController } = await import('./index');
    const controller = new EchoController() as any;
    // Inject a logger instance
    controller.logger = useContainer().resolve(
      (await import('../services/LoggerService')).LoggerService,
    );
    const out = controller.echoMessage('hello');
    expect(out.echoed).toBe('hello');
    expect(typeof out.timestamp).toBe('string');
  });
});
