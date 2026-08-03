import { takeQueuedHeaders } from './request.ts';

/**
 * Response helpers.
 *
 * `Set-Cookie` is the reason this file exists. A `Headers` object cannot be
 * built from an object literal with two `set-cookie` entries, `Headers.set`
 * overwrites, and headers on a `Response` that has already been returned are
 * guarded — so the only way to emit several cookies is `append` onto a fresh
 * `Headers` and rebuild the response around it.
 */

export function withHeaders(
  response: Response,
  extra: ReadonlyArray<readonly [string, string]>,
): Response {
  if (extra.length === 0) return response;
  const headers = new Headers(response.headers);
  // `append`, not `set`: Set-Cookie is the one header that legitimately repeats.
  for (const [name, value] of extra) headers.append(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * An itty `finally[]` handler that drains headers queued by a guard.
 *
 * Guards run before the handler and may need to set a rotated session cookie on
 * a response that does not exist yet, so they queue onto the request and this
 * applies the result.
 */
export function applyAuthHeaders(response: unknown, request: unknown): unknown {
  // itty runs `finally` handlers even when no route matched, in which case
  // `response` is undefined.
  if (!(response instanceof Response)) return response;
  return withHeaders(response, takeQueuedHeaders(request));
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** A JSON response that must never be cached — anything carrying identity. */
export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return json(body, { ...init, headers });
}

/** A redirect carrying `Set-Cookie` headers, which `Response.redirect` cannot do. */
export function redirect(
  location: string,
  cookies: readonly string[] = [],
  status: 302 | 303 | 307 = 303,
): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}
