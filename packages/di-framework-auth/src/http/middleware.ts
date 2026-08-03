import { useContainer } from '@di-framework/core/container';
import { challengesOf } from '../chain.ts';
import { makeContext } from '../context.ts';
import { AuthError } from '../errors.ts';
import { AUTH_STRATEGY } from '../tokens.ts';
import type { AuthContainer, AuthStrategy } from '../types.ts';
import { queueHeader, setPrincipal } from './request.ts';

/**
 * Authentication guards for `@di-framework/http`.
 *
 * These work with the router exactly as it ships: `TypedRouter(opts)` already
 * forwards `before`, `catch`, and `finally` straight through to itty
 * (typed-router.ts:80), and itty short-circuits a route as soon as a handler
 * returns anything non-nullish. So a guard is just a handler that returns
 * `undefined` to pass and a `Response` to reject.
 */

export interface AuthGuardOptions {
  /** `'require'` rejects with 401; `'optional'` attaches the principal if present. */
  mode?: 'require' | 'optional';
  /** Explicit strategy, or a factory. Resolved from DI when omitted. */
  strategy?: AuthStrategy | (() => AuthStrategy);
  /** DI token used when `strategy` is omitted. Defaults to `auth.Strategy`. */
  strategyToken?: string;
  container?: AuthContainer;
  /** Build the rejection response yourself. */
  onUnauthenticated?: (request: Request, error: AuthError) => Response | Promise<Response>;
}

/**
 * Provider resolution, in the same order `@di-framework/events` uses for
 * transports: explicit instance → factory → DI token with a documented default.
 */
function resolveStrategy(options: AuthGuardOptions): AuthStrategy {
  if (typeof options.strategy === 'function') return options.strategy();
  if (options.strategy) return options.strategy;

  const container = options.container ?? (useContainer() as unknown as AuthContainer);
  const token = options.strategyToken ?? AUTH_STRATEGY;
  const resolved = container.resolve?.<AuthStrategy>(token);
  if (!resolved) {
    throw new Error(
      `No authentication strategy registered under '${token}'. Call registerAuth() during ` +
        'startup, or pass { strategy } to the guard.',
    );
  }
  return resolved;
}

/**
 * Run the guard against a request.
 *
 * Returns `undefined` when the request may proceed — which is precisely itty's
 * "continue" signal — and a `Response` when it must not.
 */
export async function runGuard(
  request: Request,
  options: AuthGuardOptions = {},
): Promise<Response | undefined> {
  const strategy = resolveStrategy(options);
  const context = makeContext(request);
  const result = await strategy.authenticate(context);

  if (result.state === 'authenticated') {
    setPrincipal(request, result.principal);
    // A strategy may want to set a rotated cookie; the response does not exist
    // yet, so queue it for the `finally` handler.
    for (const [name, value] of result.headers ?? []) queueHeader(request, name, value);
    return undefined;
  }

  if (options.mode === 'optional' && result.state === 'no-credential') return undefined;

  const challenges = challengesOf([strategy], context);
  const error =
    result.state === 'failed'
      ? AuthError.fromFailure(result, challenges)
      : new AuthError('No credential presented', { code: 'no_credential', challenges });

  // A *failed* credential is rejected even in optional mode. Falling through to
  // anonymous would turn a rejected token into a silently downgraded one.
  return options.onUnauthenticated ? options.onUnauthenticated(request, error) : error.toResponse();
}

/**
 * An itty-compatible handler for the global `before[]` array.
 *
 * ```ts
 * const router = TypedRouter({ before: [requireAuth()], catch: withAuthErrors() });
 * ```
 *
 * Note that `before[]` runs *before* route matching, so `req.params` and
 * `req.route` are not populated there — any path-based policy must read
 * `new URL(req.url).pathname`.
 */
export function requireAuth(options: AuthGuardOptions = {}) {
  return (request: Request): Promise<Response | undefined> =>
    runGuard(request, { ...options, mode: 'require' });
}

/** Attaches a principal when one is present, and lets the request through when not. */
export function optionalAuth(options: AuthGuardOptions = {}) {
  return (request: Request): Promise<Response | undefined> =>
    runGuard(request, { ...options, mode: 'optional' });
}

/**
 * Guard everything except a set of public paths.
 *
 * Reads `pathname` rather than `req.route` because `before[]` runs ahead of
 * route matching.
 */
export function requireAuthExcept(
  publicPaths: readonly (string | RegExp)[],
  options: AuthGuardOptions = {},
) {
  const matches = (pathname: string): boolean =>
    publicPaths.some((entry) =>
      typeof entry === 'string'
        ? pathname === entry || pathname.startsWith(`${entry}/`)
        : entry.test(pathname),
    );

  return (request: Request): Promise<Response | undefined> | undefined => {
    if (matches(new URL(request.url).pathname)) return undefined;
    return runGuard(request, { ...options, mode: 'require' });
  };
}
