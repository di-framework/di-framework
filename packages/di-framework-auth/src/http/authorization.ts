import type {
  HandlerController,
  RequestSpec,
  ResponseSpec,
  TypedRequest,
  TypedResponse,
} from '@di-framework/http';
import {
  type AuthorizationContext,
  type AuthorizationManagerOptions,
  resolveAuthorizationManager,
} from '../authorization.ts';
import { AuthError } from '../errors.ts';
import type { Principal } from '../principal.ts';
import { getPrincipal } from './request.ts';

/** Context supplied to an authorization manager for an HTTP request. */
export interface HttpAuthorizationContext<TMetadata = unknown>
  extends AuthorizationContext<TMetadata> {
  readonly transport: 'http';
  readonly request: Request;
}

export interface AuthorizationGuardOptions<TMetadata = unknown>
  extends AuthorizationManagerOptions<HttpAuthorizationContext<TMetadata>> {
  /** Opaque policy input interpreted only by the manager. */
  metadata?: TMetadata;
  /** Pass an absent principal to the manager. Default false (respond with 401). */
  allowAnonymous?: boolean;
  /** Build a custom 403 response. The full denial reason is available on `error`. */
  onDenied?: (request: Request, error: AuthError) => Response | Promise<Response>;
}

/** Run the registered policy manager and return itty's continue/reject signal. */
export async function runAuthorizationGuard<TMetadata = unknown>(
  request: Request,
  options: AuthorizationGuardOptions<TMetadata> = {},
): Promise<Response | undefined> {
  const manager = resolveAuthorizationManager(options);
  const principal = getPrincipal<Principal>(request);

  if (!principal && !options.allowAnonymous) {
    return AuthError.unauthenticated().toResponse();
  }

  const result = await manager.authorize(principal, {
    transport: 'http',
    request,
    metadata: options.metadata as TMetadata,
  });
  if (result.allowed) return undefined;

  const error = AuthError.forbidden(
    result.reason ?? 'Authorization manager denied access',
    result.reason === undefined && result.detail === undefined
      ? undefined
      : {
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          detail: result.detail,
        },
  );
  return options.onDenied ? options.onDenied(request, error) : error.toResponse();
}

/**
 * An itty-compatible authorization guard.
 *
 * Place it after `requireAuth()` in `RouteOptions.use`, or use the
 * `authorization` route option on `withAuthRoutes()`.
 */
export function requireAuthz<TMetadata = unknown>(
  options: AuthorizationGuardOptions<TMetadata> = {},
) {
  return (request: Request): Promise<Response | undefined> =>
    runAuthorizationGuard(request, options);
}

/** Wrap a handler with authorization when authentication already ran. */
export function authorize<
  ReqSpec = RequestSpec<unknown>,
  ResSpec = ResponseSpec<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors HandlerController's default.
  Args extends any[] = any[],
  TMetadata = unknown,
>(
  controller: (
    request: TypedRequest<ReqSpec>,
    ...args: Args
  ) => TypedResponse<ResSpec> | Promise<TypedResponse<ResSpec>>,
  options: AuthorizationGuardOptions<TMetadata> = {},
): HandlerController<ReqSpec, ResSpec, Args> {
  return (async (request: TypedRequest<ReqSpec>, ...args: Args) => {
    const rejection = await runAuthorizationGuard(request as unknown as Request, options);
    if (rejection) return rejection as TypedResponse<ResSpec>;
    return controller(request, ...args);
  }) as HandlerController<ReqSpec, ResSpec, Args>;
}
