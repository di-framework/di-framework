import { useContainer } from '@di-framework/core/container';
import type { Principal } from './principal.ts';
import { AUTHORIZATION_MANAGER } from './tokens.ts';
import type { AuthContainer } from './types.ts';

/** A policy decision returned by an {@link AuthorizationManager}. */
export type AuthorizationResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason?: string };

/**
 * Common context shared by the HTTP and GraphQL integrations.
 *
 * `metadata` is deliberately opaque. The framework does not interpret roles,
 * permissions, resources, or actions; those concepts belong to the manager.
 */
export interface AuthorizationContext<TMetadata = unknown> {
  readonly transport: 'http' | 'graphql' | (string & {});
  readonly metadata: TMetadata;
}

/**
 * Pluggable policy decision point, analogous to Spring Security's
 * `AuthorizationManager`.
 */
export interface AuthorizationManager<TContext = AuthorizationContext> {
  authorize(
    principal: Principal | undefined,
    context: TContext,
  ): AuthorizationResult | Promise<AuthorizationResult>;
}

/** Sources accepted anywhere an authorization manager can be overridden. */
export interface AuthorizationManagerOptions<TContext = AuthorizationContext> {
  /** Explicit manager (or factory), preferred over DI. */
  manager?: AuthorizationManager<TContext> | (() => AuthorizationManager<TContext>);
  /** DI token used when `manager` is omitted. */
  managerToken?: string;
  container?: AuthContainer;
}

/** Resolve an explicit manager or the default registered with `registerAuth()`. */
export function resolveAuthorizationManager<TContext = AuthorizationContext>(
  options: AuthorizationManagerOptions<TContext> = {},
): AuthorizationManager<TContext> {
  if (typeof options.manager === 'function') return options.manager();
  if (options.manager) return options.manager;

  const container = options.container ?? (useContainer() as unknown as AuthContainer);
  const token = options.managerToken ?? AUTHORIZATION_MANAGER;
  const resolved =
    container.has?.(token) === false
      ? undefined
      : container.resolve?.<AuthorizationManager<TContext>>(token);
  if (!resolved) {
    throw new Error(
      `No authorization manager registered under '${token}'. Call registerAuth({ authorization }) ` +
        'during startup, or pass { manager } to the authorization guard.',
    );
  }
  return resolved;
}

export function authorizationAllowed(): AuthorizationResult {
  return { allowed: true };
}

export function authorizationDenied(reason?: string): AuthorizationResult {
  return reason === undefined ? { allowed: false } : { allowed: false, reason };
}
