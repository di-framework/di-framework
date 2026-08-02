import { beforeAll, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { DatabaseService } from '../../services/DatabaseService';
import { LoggerService } from '../../services/LoggerService';
import { UserService } from '../../services/UserService';
import { badRequest, handleRequest } from './router';
import { ConfigService } from './services/ConfigService';
import { CounterService } from './services/CounterService';

type ServiceCtor = new (...args: any[]) => unknown;

describe('cf-worker router', () => {
  beforeAll(() => {
    const container = useContainer();
    const db = container.has(DatabaseService)
      ? container.resolve(DatabaseService)
      : new DatabaseService();
    const logger = container.has(LoggerService)
      ? container.resolve(LoggerService)
      : new LoggerService();
    if (!container.has(DatabaseService))
      container.registerFactory(DatabaseService as any, () => db, { singleton: true });
    if (!container.has(LoggerService))
      container.registerFactory(LoggerService as any, () => logger, { singleton: true });
    if (!container.has(UserService)) {
      container.registerFactory(UserService as any, () => new UserService(db, logger), {
        singleton: true,
      });
    }
    if (!container.has(ConfigService)) container.register(ConfigService, { singleton: true });
    if (!container.has(CounterService)) container.register(CounterService, { singleton: true });
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

  test('GET /api/logs returns logs', async () => {
    const req = new Request('http://localhost/api/logs');
    const res = await handleRequest(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test('GET and POST /api/users routes', async () => {
    // Create user
    const createReq = new Request(
      'http://localhost/api/users?id=u100&name=Bob&email=bob@example.com',
    );
    const createRes = await handleRequest(createReq, mockEnv, mockCtx);
    expect(createRes.status).toBe(200);

    // Get user
    const getReq = new Request('http://localhost/api/users?id=u100');
    const getRes = await handleRequest(getReq, mockEnv, mockCtx);
    expect(getRes.status).toBe(200);

    // Get missing user
    const getMissingReq = new Request('http://localhost/api/users?id=missing');
    const getMissingRes = await handleRequest(getMissingReq, mockEnv, mockCtx);
    expect(getMissingRes.status).toBe(404);

    // List users
    const listReq = new Request('http://localhost/api/users');
    const listRes = await handleRequest(listReq, mockEnv, mockCtx);
    expect(listRes.status).toBe(200);
  });

  test('badRequest returns a 400 JSON response', async () => {
    const res = badRequest('Nope');
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: 'Nope' });

    const defaults = badRequest();
    expect(defaults.status).toBe(400);
    expect((await defaults.json()) as unknown).toEqual({ error: 'Bad request' });
  });

  test('counter routes with mock Durable Object', async () => {
    let countValue = 0;
    const mockDOEnv = {
      MY_DURABLE_OBJECT: {
        getByName: () => ({
          increment: async (delta: number) => (countValue += delta),
          getCount: async () => countValue,
          reset: async () => (countValue = 0),
          sayHello: async (name: string) => `Hello ${name}`,
        }),
      },
    };

    // GET /api/count
    const getReq = new Request('http://localhost/api/count');
    const getRes = await handleRequest(getReq, mockDOEnv, mockCtx);
    expect(getRes.status).toBe(200);

    // POST /api/count
    const postReq = new Request('http://localhost/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delta: 5 }),
    });
    const postRes = await handleRequest(postReq, mockDOEnv, mockCtx);
    expect(postRes.status).toBe(200);

    // POST /api/count/reset
    const resetReq = new Request('http://localhost/api/count/reset', { method: 'POST' });
    const resetRes = await handleRequest(resetReq, mockDOEnv, mockCtx);
    expect(resetRes.status).toBe(200);

    // GET /api/hello
    const helloReq = new Request('http://localhost/api/hello');
    const helloRes = await handleRequest(helloReq, mockDOEnv, mockCtx);
    expect(helloRes.status).toBe(200);
    const helloBody: any = await helloRes.json();
    expect(helloBody.greeting).toBe('Hello world');
  });
});
