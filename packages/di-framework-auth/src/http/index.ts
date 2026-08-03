export { type AuthErrorHandlerOptions, authErrorHandler, withAuthErrors } from './catch.ts';
export {
  type AuthGuardOptions,
  optionalAuth,
  requireAuth,
  requireAuthExcept,
  runGuard,
} from './middleware.ts';
export {
  publicEndpoint,
  type SecuritySchemeOptions,
  secured,
  securitySchemesFor,
} from './openapi.ts';
export {
  getPrincipal,
  isAuthenticated,
  PENDING_HEADERS,
  PRINCIPAL,
  queueHeader,
  requirePrincipal,
  setPrincipal,
  takeQueuedHeaders,
  type WithOptionalPrincipal,
  type WithPrincipal,
} from './request.ts';
export { applyAuthHeaders, json, privateJson, redirect, withHeaders } from './responses.ts';
export {
  type AuthedRequest,
  type AuthedRoute,
  type AuthedRouteOptions,
  type AuthedRouter,
  mountAuthRoutes,
  type OptionalAuthedRequest,
  optional,
  protect,
  withAuthRoutes,
} from './router.ts';
export { type AuthRoutesOptions, createAuthRoutes } from './routes.ts';
