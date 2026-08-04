/**
 * Auth as a domain concern.
 *
 * A requirement is declared next to the field or action it protects, the same
 * way ownership is declared with `@BoundedContext` — not threaded through
 * hand-written `requireLibrarian(ctx)` guards at the top of every resolver.
 *
 * Requirements are read off the per-request context. What counts as the
 * principal, its roles and its claims is application-specific, so every reader
 * is overridable through {@link AuthorizationOptions}; the defaults cover the
 * common `ctx.user = { roles, claims }` shape.
 */

import type { GraphQLContext } from './types.ts';

/** Raised when a declared requirement is not met. */
export class SemanticAuthorizationError extends Error {
  readonly extensions: { code: string };

  constructor(message = 'Not authorized.', code = 'FORBIDDEN') {
    super(message);
    this.name = 'SemanticAuthorizationError';
    // graphql-js copies `extensions` off the original error, so this is what
    // reaches the client — and it carries no internal detail.
    this.extensions = { code };
  }
}

export interface AuthRequirementContext {
  parent: unknown;
  args: Record<string, any>;
  ctx: GraphQLContext;
  info: any;
}

export interface AuthRequirement {
  /** Satisfied when the principal holds *any* of these roles. */
  roles?: readonly string[];
  /** Satisfied only when the principal holds *every* one of these roles. */
  allRoles?: readonly string[];
  /**
   * Claims that must match. A scalar must be equal; an array is satisfied when
   * the principal's claim is one of its entries.
   */
  claims?: Readonly<Record<string, unknown>>;
  /** Arbitrary domain rule — ownership checks and the like. */
  predicate?: (context: AuthRequirementContext) => boolean | Promise<boolean>;
  /** Message surfaced to the client. Keep it free of internals. */
  message?: string;
  /** Require only that a principal is present. */
  authenticated?: boolean;
}

export interface AuthorizationOptions {
  /** Defaults to `ctx.user ?? ctx.principal`. */
  principal?: (ctx: GraphQLContext) => unknown;
  /** Defaults to the principal's `roles`, else `ctx.roles`. */
  roles?: (ctx: GraphQLContext, principal: unknown) => readonly string[];
  /** Defaults to the principal's `claims`, else `ctx.claims`, else the principal. */
  claims?: (ctx: GraphQLContext, principal: unknown) => Record<string, unknown>;
  /** Build the error for a failed requirement. */
  onDenied?: (denial: AuthDenial) => Error;
}

export interface AuthDenial {
  /** `Type.field` the requirement was declared on. */
  path: string;
  requirement: AuthRequirement;
  /** True when no principal was present at all. */
  anonymous: boolean;
  reason: 'unauthenticated' | 'roles' | 'claims' | 'predicate';
}

function defaultPrincipal(ctx: GraphQLContext): unknown {
  return ctx?.user ?? ctx?.principal;
}

function defaultRoles(ctx: GraphQLContext, principal: unknown): readonly string[] {
  const fromPrincipal = (principal as any)?.roles;
  const roles = fromPrincipal ?? ctx?.roles;
  if (Array.isArray(roles)) return roles.filter((role): role is string => typeof role === 'string');
  return typeof roles === 'string' ? [roles] : [];
}

function defaultClaims(ctx: GraphQLContext, principal: unknown): Record<string, unknown> {
  const fromPrincipal = (principal as any)?.claims;
  const claims = fromPrincipal ?? ctx?.claims ?? principal;
  return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : {};
}

function claimMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      ? actual.some((value) => expected.includes(value))
      : expected.includes(actual);
  }
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

/**
 * Check every requirement declared for a field.
 *
 * Requirements are conjunctive: each one must pass. Returns the first denial,
 * or `null` when the caller is allowed through.
 */
export async function evaluateRequirements(
  requirements: readonly AuthRequirement[],
  path: string,
  context: AuthRequirementContext,
  options: AuthorizationOptions = {},
): Promise<AuthDenial | null> {
  if (requirements.length === 0) return null;

  const { ctx } = context;
  const principal = (options.principal ?? defaultPrincipal)(ctx);
  const anonymous = principal === undefined || principal === null;

  for (const requirement of requirements) {
    const needsPrincipal =
      requirement.authenticated === true ||
      (requirement.roles?.length ?? 0) > 0 ||
      (requirement.allRoles?.length ?? 0) > 0 ||
      requirement.claims !== undefined;

    if (needsPrincipal && anonymous) {
      return { path, requirement, anonymous, reason: 'unauthenticated' };
    }

    if (requirement.roles?.length) {
      const held = (options.roles ?? defaultRoles)(ctx, principal);
      if (!requirement.roles.some((role) => held.includes(role))) {
        return { path, requirement, anonymous, reason: 'roles' };
      }
    }

    if (requirement.allRoles?.length) {
      const held = (options.roles ?? defaultRoles)(ctx, principal);
      if (!requirement.allRoles.every((role) => held.includes(role))) {
        return { path, requirement, anonymous, reason: 'roles' };
      }
    }

    if (requirement.claims) {
      const held = (options.claims ?? defaultClaims)(ctx, principal);
      for (const [key, expected] of Object.entries(requirement.claims)) {
        if (!claimMatches(held[key], expected)) {
          return { path, requirement, anonymous, reason: 'claims' };
        }
      }
    }

    if (requirement.predicate && !(await requirement.predicate(context))) {
      return { path, requirement, anonymous, reason: 'predicate' };
    }
  }

  return null;
}

/**
 * Turn a denial into the error the client sees.
 *
 * The default deliberately says nothing about which rule failed or what the
 * principal was missing — only whether to authenticate or give up.
 */
export function denialToError(denial: AuthDenial, options: AuthorizationOptions = {}): Error {
  if (options.onDenied) return options.onDenied(denial);
  return denial.reason === 'unauthenticated'
    ? new SemanticAuthorizationError(
        denial.requirement.message ?? 'Authentication is required.',
        'UNAUTHENTICATED',
      )
    : new SemanticAuthorizationError(denial.requirement.message ?? 'Not authorized.', 'FORBIDDEN');
}
