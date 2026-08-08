import { AuthError } from '../errors.ts';
import type { Principal } from '../principal.ts';

/**
 * Reading the principal inside a handler.
 *
 * The container has no request scope, but itty passes **one object identity**
 * (`req.proxy ?? req`) to every handler in a single `fetch()` call, and a
 * `Request` is per-invocation. So attaching the principal to the request object
 * *is* request scope — it simply is not ambient.
 *
 * A `@CurrentUser()` parameter decorator is deliberately not provided. Handlers
 * are static class properties invoked with itty's positional `(req, ...args)`,
 * not through a DI-constructed call; with `emitDecoratorMetadata: false` and no
 * `AsyncLocalStorage`, a parameter decorator has nothing to hook into. Building
 * one would require a module-level "current request", which is unsound the
 * moment two requests are in flight — and in Bun and Workers they always are.
 */

/** Symbol key, so the principal cannot be forged through a JSON body field. */
export const PRINCIPAL = Symbol.for('@di-framework/auth:principal');
/** Headers a guard queued for the eventual response (rotated cookies, and so on). */
export const PENDING_HEADERS = Symbol.for('@di-framework/auth:pending-headers');

/** A request that has passed an authentication guard. */
export type WithPrincipal<R, P = Principal> = R & { principal: P };
/** A request that ran an optional guard: the principal may be absent. */
export type WithOptionalPrincipal<R, P = Principal> = R & { principal?: P };

// biome-ignore lint/suspicious/noExplicitAny: itty's IRequest is an open proxy.
type Mutable = Record<string | symbol, any>;

/**
 * Attach a principal to the request.
 *
 * Written under both a symbol and the plain `principal` property: the symbol is
 * the one guards read back, so a client that posts `{"principal": …}` cannot
 * spoof it; the plain property is what makes `req.principal` read naturally in a
 * handler and show up in a debug log.
 */
export function setPrincipal(request: unknown, principal: Principal): void {
  const target = request as Mutable;
  target[PRINCIPAL] = principal;
  target.principal = principal;
}

export function getPrincipal<P = Principal>(request: unknown): P | undefined {
  return (request as Mutable | null | undefined)?.[PRINCIPAL] as P | undefined;
}

/** Throws `AuthError` (401) when unauthenticated; `withAuthErrors` renders it. */
export function requirePrincipal<P = Principal>(request: unknown): P {
  const principal = getPrincipal<P>(request);
  if (!principal) throw AuthError.unauthenticated();
  return principal;
}

/** Type predicate for narrowing inside a handler that ran an optional guard. */
export function isAuthenticated<R>(request: R): request is WithPrincipal<R> {
  return getPrincipal(request) !== undefined;
}

/** Queue a response header from inside a guard, drained by `applyAuthHeaders`. */
export function queueHeader(request: unknown, name: string, value: string): void {
  const target = request as Mutable;
  const pending = (target[PENDING_HEADERS] as Array<[string, string]> | undefined) ?? [];
  pending.push([name, value]);
  target[PENDING_HEADERS] = pending;
}

export function takeQueuedHeaders(request: unknown): Array<[string, string]> {
  const target = request as Mutable | null | undefined;
  const pending = target?.[PENDING_HEADERS] as Array<[string, string]> | undefined;
  if (!pending?.length) return [];
  // Cleared on read: a `finally[]` array with two entries would otherwise apply
  // every queued header twice.
  target![PENDING_HEADERS] = [];
  return pending;
}
