import type { HandlerOptions, SemanticSchema } from '@di-framework/graphql';
import { createGraphQLHandler } from '@di-framework/graphql';
import { AuthError } from '../errors.ts';
import { type AuthContextOptions, createAuthContext } from './context.ts';

/**
 * `createGraphQLHandler` with authentication wired in.
 *
 * The graphql handler builds its context *before* execution, so an `AuthError`
 * thrown while establishing the principal escapes as a plain rejection rather
 * than becoming a GraphQL error. This catches that case and renders a proper
 * HTTP response with the `WWW-Authenticate` header — a token that failed
 * verification is an HTTP-level problem, not a field-level one.
 *
 * Errors thrown *inside* a resolver need no special handling: graphql-js copies
 * `extensions` off `originalError`, so an `AuthError` surfaces as
 * `errors[0].extensions.code === 'UNAUTHENTICATED'` on its own.
 */
export function withAuthHandler(
  api: SemanticSchema,
  options: AuthContextOptions & Omit<HandlerOptions, 'context'>,
): (request: Request) => Promise<Response> {
  const { strategy, require, next, ...handlerOptions } = options;
  const handler = createGraphQLHandler(api, {
    ...handlerOptions,
    context: createAuthContext({
      strategy,
      ...(require !== undefined ? { require } : {}),
      ...(next ? { next } : {}),
    }),
  });

  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof AuthError) {
        return error.toResponse({
          // A GraphQL client expects the `errors` envelope even for a 401.
          status: error.status,
        });
      }
      throw error;
    }
  };
}
