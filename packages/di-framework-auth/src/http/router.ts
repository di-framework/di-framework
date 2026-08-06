import type {
  HandlerController,
  RequestSpec,
  ResponseSpec,
  RouteOptions,
  TypedRequest,
  TypedResponse,
  TypedRouterType,
} from '@di-framework/http';
import type { Principal } from '../principal.ts';
import {
  type AuthorizationGuardOptions,
  authorize,
  runAuthorizationGuard,
} from './authorization.ts';
import { type AuthGuardOptions, runGuard } from './middleware.ts';
import type { WithOptionalPrincipal, WithPrincipal } from './request.ts';

/**
 * The recommended way to protect routes.
 *
 * `withAuthRoutes(router)` returns a facade with the same call shape as the
 * router, but whose handlers receive a request typed with a non-optional
 * `principal`. It needs no change to `@di-framework/http` at all, and it
 * preserves everything the OpenAPI generator relies on — `@Endpoint` mutates
 * `handler.isEndpoint`/`.metadata` in place, and the generator reads
 * `handler.path`/`.method`, so the facade returns the router's own return value
 * verbatim rather than wrapping it.
 */

export type AuthedRequest<ReqSpec, P = Principal> = WithPrincipal<TypedRequest<ReqSpec>, P>;
export type OptionalAuthedRequest<ReqSpec, P = Principal> = WithOptionalPrincipal<
  TypedRequest<ReqSpec>,
  P
>;

export type AuthedRouteOptions = RouteOptions & {
  /** `false` leaves the route public; an options object overrides the defaults. */
  auth?: AuthGuardOptions | false;
  /** Run the registered authorization manager after authentication. */
  authorization?: AuthorizationGuardOptions | false;
};

export interface AuthedRouterDefaults extends AuthGuardOptions {
  /** Default authorization rule for routes on this facade. */
  authorization?: AuthorizationGuardOptions | false;
}

// biome-ignore lint/suspicious/noExplicitAny: mirrors TypedRouter's own Args default.
export type AuthedRoute<Args extends any[] = any[]> = <
  ReqSpec = RequestSpec<unknown>,
  ResSpec = ResponseSpec<unknown>,
>(
  path: string,
  controller: (
    request: AuthedRequest<ReqSpec>,
    ...args: Args
  ) => TypedResponse<ResSpec> | Promise<TypedResponse<ResSpec>>,
  options?: AuthedRouteOptions,
) => TypedRouterType<Args> & { path: string; method: string; reqSpec: ReqSpec; resSpec: ResSpec };

// biome-ignore lint/suspicious/noExplicitAny: mirrors TypedRouter's own Args default.
export type AuthedRouter<Args extends any[] = any[]> = {
  get: AuthedRoute<Args>;
  post: AuthedRoute<Args>;
  put: AuthedRoute<Args>;
  delete: AuthedRoute<Args>;
  patch: AuthedRoute<Args>;
  head: AuthedRoute<Args>;
  options: AuthedRoute<Args>;
};

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

export const DEFERRED_AUTHORIZATION = Symbol.for('@di-framework/auth:deferred-authorization');
export type DeferredAuthorizationBinder = (options: AuthorizationGuardOptions) => void;

/**
 * Wrap a handler so it only runs for authenticated requests.
 *
 * Prefer {@link withAuthRoutes}: bare `protect()` relies on contextual inference
 * from the return position, which gets fragile once a caller writes explicit
 * generics on `router.get<A, B>`.
 */
export function protect<
  ReqSpec = RequestSpec<unknown>,
  ResSpec = ResponseSpec<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors HandlerController's default.
  Args extends any[] = any[],
>(
  controller: (
    request: AuthedRequest<ReqSpec>,
    ...args: Args
  ) => TypedResponse<ResSpec> | Promise<TypedResponse<ResSpec>>,
  options: AuthGuardOptions = {},
): HandlerController<ReqSpec, ResSpec, Args> {
  return (async (request: TypedRequest<ReqSpec>, ...args: Args) => {
    const rejection = await runGuard(request as unknown as Request, {
      ...options,
      mode: options.mode ?? 'require',
    });
    if (rejection) return rejection as TypedResponse<ResSpec>;
    return controller(request as AuthedRequest<ReqSpec>, ...args);
  }) as HandlerController<ReqSpec, ResSpec, Args>;
}

/** As {@link protect}, but a missing credential is allowed through. */
export function optional<
  ReqSpec = RequestSpec<unknown>,
  ResSpec = ResponseSpec<unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors HandlerController's default.
  Args extends any[] = any[],
>(
  controller: (
    request: OptionalAuthedRequest<ReqSpec>,
    ...args: Args
  ) => TypedResponse<ResSpec> | Promise<TypedResponse<ResSpec>>,
  options: AuthGuardOptions = {},
): HandlerController<ReqSpec, ResSpec, Args> {
  return protect(controller as never, { ...options, mode: 'optional' }) as HandlerController<
    ReqSpec,
    ResSpec,
    Args
  >;
}

/**
 * A router facade whose handlers get a typed `req.principal`.
 *
 * ```ts
 * const secure = withAuthRoutes(router);
 *
 * @Controller()
 * export class MeController {
 *   @Endpoint({ summary: 'Current principal', security: secured('bearerAuth') })
 *   static get = secure.get('/me', async (req) => json({ sub: req.principal.sub }));
 * }
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors TypedRouter's own Args default.
export function withAuthRoutes<Args extends any[] = any[]>(
  router: TypedRouterType<Args>,
  defaults: AuthedRouterDefaults = {},
): AuthedRouter<Args> {
  // biome-ignore lint/suspicious/noExplicitAny: the facade mirrors the router's loose surface.
  const facade: any = {};

  for (const method of METHODS) {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    facade[method] = (path: string, controller: any, options: AuthedRouteOptions = {}) => {
      const { auth, authorization, ...routeOptions } = options;
      const { authorization: defaultAuthorization, ...authDefaults } = defaults;
      const authz = authorization === undefined ? defaultAuthorization : authorization;
      let deferred: AuthorizationGuardOptions | undefined;
      const lateAuthorized = async (...args: any[]) => {
        if (deferred) {
          const rejection = await runAuthorizationGuard(args[0] as Request, deferred);
          if (rejection) return rejection;
        }
        return controller(...args);
      };
      const authorized =
        authz === false || authz === undefined ? lateAuthorized : authorize(controller, authz);
      const guarded =
        auth === false ? authorized : protect(authorized, { ...authDefaults, ...auth });
      // Returned verbatim: `@Endpoint` mutates this object in place and the
      // OpenAPI generator reads `.path` / `.method` off it.
      const handler = router[method](path, guarded, routeOptions);
      Object.defineProperty(handler, DEFERRED_AUTHORIZATION, {
        configurable: false,
        enumerable: false,
        value: (binding: AuthorizationGuardOptions) => {
          if (authz !== undefined)
            throw new Error('Route-level authorization conflicts with deferred authorization');
          if (deferred) throw new Error('Authorization is already bound for this route');
          deferred = binding;
        },
      });
      return handler;
    };
  }

  return facade as AuthedRouter<Args>;
}

/**
 * Mount a sub-router under a path prefix.
 *
 * itty has no `.mount()`; the idiom is a wildcard `all` route delegating to the
 * sub-router's `fetch`. That works through `TypedRouter`'s Proxy — `all` is not
 * in its intercepted method list, so it falls through to itty's own
 * registration trap — but it is obscure enough to deserve a named helper rather
 * than a line every caller has to recognise.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors TypedRouter's own Args default.
export function mountAuthRoutes<Args extends any[] = any[]>(
  router: TypedRouterType<Args>,
  subRouter: TypedRouterType<Args>,
  basePath = '/auth',
): TypedRouterType<Args> {
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  router.all(`${prefix}/*`, subRouter.fetch);
  router.all(prefix, subRouter.fetch);
  return router;
}
