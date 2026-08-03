import { chain } from '../chain.ts';
import { makeContext } from '../context.ts';
import { AuthError } from '../errors.ts';
import type { Principal } from '../principal.ts';
import type { AuthStrategy } from '../types.ts';

/**
 * GraphQL context construction.
 *
 * `createGraphQLHandler(api, { context })` is the single `Request →
 * GraphQLContext` hook the graphql package exposes, so this is where a request's
 * credential becomes something a resolver can see.
 */

export interface AuthGraphQLContext extends Record<string, unknown> {
  principal?: Principal;
}

export interface AuthContextOptions {
  strategy: AuthStrategy | readonly AuthStrategy[];
  /**
   * Reject unauthenticated requests before any resolver runs.
   *
   * Off by default: a schema usually has a public surface, and the per-field
   * `@Authenticated()` decorator expresses that far better than an
   * all-or-nothing gate.
   */
  require?: boolean;
  /** Compose with your own context factory; its result is merged underneath. */
  next?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Build a context factory for `createGraphQLHandler`.
 *
 * ```ts
 * const handler = createGraphQLHandler(protectSchema(buildSemanticSchema()), {
 *   context: createAuthContext({ strategy: runtime.strategy }),
 * });
 * ```
 *
 * The returned object is always fresh per request. That matters beyond hygiene:
 * `@di-framework/graphql` keys its per-request batching and hydration state on
 * the *identity* of the context object, so a shared object would leak one
 * request's dataloader cache into the next.
 */
export function createAuthContext(options: AuthContextOptions) {
  const strategy = Array.isArray(options.strategy)
    ? chain(options.strategy as readonly AuthStrategy[])
    : (options.strategy as AuthStrategy);

  return async (request: Request): Promise<AuthGraphQLContext> => {
    const base = options.next ? await options.next(request) : {};
    const result = await strategy.authenticate(makeContext(request));

    if (result.state === 'authenticated') {
      return { ...base, principal: result.principal };
    }

    // A *failed* credential always throws, even when `require` is off — a
    // rejected token must not silently become an anonymous request.
    if (result.state === 'failed') throw AuthError.fromFailure(result);
    if (options.require) throw AuthError.unauthenticated();

    return { ...base };
  };
}

export function getPrincipal(context: AuthGraphQLContext): Principal | undefined {
  return context.principal;
}

/**
 * Require an authenticated principal inside a resolver.
 *
 * Deliberately the only helper of its kind. There is no `requireRole` and there
 * will not be: authorization belongs in your domain, in the style the repo's
 * GraphQL example already uses.
 */
export function requirePrincipal(context: AuthGraphQLContext): Principal {
  const principal = context.principal;
  // Redacted: graphql-js copies `error.message` straight into the response.
  if (!principal) throw AuthError.unauthenticated().redacted();
  return principal;
}

/** The authenticated subject id. */
export function requireSubject(context: AuthGraphQLContext): string {
  return requirePrincipal(context).sub;
}
