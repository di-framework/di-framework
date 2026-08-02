import { beforeAll, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import { DatabaseService } from '../../services/DatabaseService';
import { LoggerService } from '../../services/LoggerService';
import { UserService } from '../../services/UserService';
import { handleRequest } from './router';
import { ConfigService } from './services/ConfigService';
import { CounterService } from './services/CounterService';

type ServiceCtor = new (...args: any[]) => unknown;

describe('cf-worker router', () => {
  beforeAll(() => {
    const container = useContainer();
    // Register services that router.ts resolves by class reference.
    // Needed because workspace module resolution can cause the @Container()
    // decorator to register into a different container singleton than the
    // one router.ts uses (dist/ vs source .ts dual-loading).
    const services: ServiceCtor[] = [
      LoggerService,
      DatabaseService,
      UserService,
      ConfigService,
      CounterService,
    ];
    for (const Svc of services) {
      if (!container.has(Svc)) container.register(Svc, { singleton: true });
    }
    if (!container.has('APP_NAME')) {
      container.registerFactory('APP_NAME', () => 'Test Worker', {
        singleton: true,
      });
    }
  });

  const mockEnv = {};
  const mockCtx = {};

  test('GET / returns HTML index', async () => {
    const req = new Request('http://localhost/');
    const res = await handleRequest(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('DI Worker Example');
  });

  test('GET /api/info returns info and services', async () => {
    const req = new Request('http://localhost/api/info');
    const res = await handleRequest(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.services).toBeDefined();
    expect(Array.isArray(body.services)).toBe(true);
  });

  test('GET /api/not-found returns 404', async () => {
    const req = new Request('http://localhost/api/not-found');
    const res = await handleRequest(req, mockEnv, mockCtx);
    expect(res.status).toBe(404);
  });
});
