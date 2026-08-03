import type { Env } from './env';

export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const allowed = (env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  const allow =
    allowed.includes('*') || allowed.includes(origin) ? origin || '*' : allowed[0] || '*';

  return {
    'access-control-allow-origin': allow || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

/** Attach CORS headers to an existing response. */
export function withCors(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, request))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
