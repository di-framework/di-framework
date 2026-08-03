import { AuthError } from '../errors.ts';

/**
 * Error handling for itty's `catch` hook.
 *
 * `@di-framework/http` has no error handling of its own, and itty's `catch` is
 * the only thing standing between a thrown error and an unhandled rejection. If
 * it returns `undefined`, `router.fetch()` resolves to `undefined` and the
 * runtime emits a bodiless 500 — so these handlers always return a `Response`.
 */

export interface AuthErrorHandlerOptions {
  /** Log the full (non-public) error. Defaults to `console.error`. */
  log?: (error: AuthError) => void;
  /** Handle anything that is not an `AuthError`. */
  fallback?: (error: unknown, ...args: unknown[]) => Response | Promise<Response>;
}

function defaultFallback(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  // biome-ignore lint/suspicious/noConsole: an unhandled server error must be visible.
  console.error('[@di-framework/auth] Unhandled error:', error);
  const status =
    typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : 500;
  return new Response(
    JSON.stringify({ error: status === 500 ? 'Internal Server Error' : message, status }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/**
 * Build a `catch` handler that renders `AuthError` and defers everything else.
 *
 * ```ts
 * const router = TypedRouter({ catch: withAuthErrors() });
 * ```
 */
export function withAuthErrors(options: AuthErrorHandlerOptions = {}) {
  const log =
    options.log ??
    ((error: AuthError) => {
      // The detailed message goes to logs; `toResponse` sends only the generic
      // public text, so the two must not be conflated.
      // biome-ignore lint/suspicious/noConsole: authentication failures must be auditable.
      console.warn(`[@di-framework/auth] ${error.code}: ${error.message}`);
    });

  return (error: unknown, ...args: unknown[]): Response | Promise<Response> => {
    if (error instanceof AuthError) {
      log(error);
      return error.toResponse();
    }
    return options.fallback ? options.fallback(error, ...args) : defaultFallback(error);
  };
}

/** Render an `AuthError`, or return `undefined` to let another handler decide. */
export function authErrorHandler(error: unknown): Response | undefined {
  return error instanceof AuthError ? error.toResponse() : undefined;
}
