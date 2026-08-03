import { parseCookies } from './cookies.ts';
import type { AuthRequestContext } from './types.ts';

/**
 * Build the shared per-request context handed to every strategy in a chain.
 *
 * Parsing cookies and the URL once and passing them along is not only cheaper —
 * it means every strategy in the chain sees exactly the same view of the
 * request, so a strategy cannot accidentally disagree with the one before it
 * about what the URL or a cookie contains.
 */
export function makeContext(request: Request): AuthRequestContext {
  return {
    request,
    cookies: parseCookies(request.headers.get('cookie')),
    url: new URL(request.url),
    method: request.method.toUpperCase(),
  };
}
