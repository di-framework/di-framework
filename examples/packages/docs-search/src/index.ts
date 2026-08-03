import { json } from '@di-framework/http';
import { bindEnv, bootstrap } from './bootstrap';
import { withCors } from './cors';
import type { Env } from './env';
import { router } from './router';

// Controllers register routes on `router` via static `@Endpoint` properties
import './controllers/AuthController';
import './controllers/HealthController';
import './controllers/ReindexController';
import './controllers/SearchController';

/** Strip mount path on di-framework.dev (e.g. /api/docs/search). */
function appPath(pathname: string, env: Env): string {
  const base = (env.BASE_PATH || '').replace(/\/$/, '');
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
    const rest = pathname.slice(base.length) || '/';
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname;
}

function withAppPath(request: Request, env: Env): Request {
  const url = new URL(request.url);
  const path = appPath(url.pathname, env);
  if (path === url.pathname) return request;
  url.pathname = path;
  return new Request(url, request);
}

/**
 * Cloudflare Worker entry — Writerside custom search + AI embeddings,
 * wired with @di-framework/core, @di-framework/repo, and @di-framework/http
 * (Controller → Service → Repo).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    bindEnv(env);
    await bootstrap();

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env, request);
    }

    const routed = withAppPath(request, env);
    const response =
      (await router.fetch(routed, env, ctx)) ?? json({ error: 'Not found' }, { status: 404 });

    return withCors(response, env, request);
  },
} satisfies ExportedHandler<Env>;

export { router };
