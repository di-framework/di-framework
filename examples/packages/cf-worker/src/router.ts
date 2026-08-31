import { useContainer } from '@di-framework/core/container';
import { DatabaseService } from '@di-framework/services-example/DatabaseService';
import { LoggerService } from '@di-framework/services-example/LoggerService';
import { UserService } from '@di-framework/services-example/UserService';
import { ConfigService } from './services/ConfigService';
import { CounterService } from './services/CounterService';

const container = useContainer();

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

function notFound(message = 'Not found') {
  return json({ error: message }, { status: 404 });
}

/** Exported for tests; used when a request body cannot be parsed. */
export function badRequest(message = 'Bad request') {
  return json({ error: message }, { status: 400 });
}

function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

function header(title: string) {
  return `<header style="margin-bottom:1rem"><h1>${title}</h1><p>Built with a lightweight DI container (decorators + auto-wiring)</p></header>`;
}

export async function handleRequest(request: Request, env: any, _ctx: any) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Useful services resolved via DI
  const logger = container.resolve<LoggerService>(LoggerService);
  const config = container.resolve<ConfigService>(ConfigService);
  const users = container.resolve<UserService>(UserService);
  const db = container.resolve<DatabaseService>(DatabaseService);
  const counter = container.resolve<CounterService>(CounterService);

  // Simple HTML index
  if (path === '/') {
    const services = container.getServiceNames().sort();
    const body = `
      ${header('DI Worker Example')}
      <main>
        <p>Try these routes:</p>
        <ul>
          <li><a href="/api/info">GET /api/info</a></li>
          <li><a href="/api/logs">GET /api/logs</a></li>
          <li><a href="/api/users">GET /api/users</a></li>
          <li><a href="/api/users?id=1&name=Jane&email=jane%40example.com">GET /api/users?id=...&name=...&email=...</a></li>
          <li><a href="/api/count">GET /api/count</a></li>
        </ul>
        <pre style="background:#111;color:#eee;padding:0.75rem;border-radius:6px;">Registered services:\n${services
          .map((s: any) => `- ${s}`)
          .join('\n')}</pre>
      </main>
    `;
    return html(body);
  }

  // Info: shows token-based injection + container insight
  if (path === '/api/info' && request.method === 'GET') {
    logger.log('/api/info called');
    const info = config.info(env);
    return json({
      info,
      services: container.getServiceNames().sort(),
      durableObjectName: 'MY_DURABLE_OBJECT',
    });
  }

  if (path === '/api/logs' && request.method === 'GET') {
    return json({ logs: logger.getLogs() });
  }

  if (path.startsWith('/api/users') && request.method === 'GET') {
    // Ensure our fake DB is connected once
    if (!db.isConnected()) db.connect();

    const id = url.searchParams.get('id');
    const name = url.searchParams.get('name');
    const email = url.searchParams.get('email');

    if (id && name && email) {
      const user = users.createUser(id, name, email);
      return json({ created: user });
    }

    if (id) {
      const user = users.getUser(id);
      if (!user) return notFound('User not found');
      return json({ user });
    }

    return json({ users: users.listUsers() });
  }

  if (path === '/api/count' && request.method === 'GET') {
    const value = await counter.get(env);
    return json({ value });
  }

  if (path === '/api/count' && request.method === 'POST') {
    let delta = 1;
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      if (typeof body?.delta === 'number') delta = body.delta;
    } catch {
      // ignore
    }
    const value = await counter.increment(env, delta);
    return json({ value });
  }

  if (path === '/api/count/reset' && request.method === 'POST') {
    const value = await counter.reset(env);
    return json({ value });
  }

  if (path === '/api/hello' && request.method === 'GET') {
    const stub = (env as any).MY_DURABLE_OBJECT.getByName('counter');
    const greeting = await stub.sayHello('world');
    return json({ greeting });
  }

  return notFound();
}
