import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';
import type { AuthorizationManager } from '../authorization.ts';

/**
 * `@Authenticated()` for GraphQL types and fields.
 *
 * Uses core's own metadata store, exactly as `@di-framework/graphql`'s
 * `metadata.ts` does — no `reflect-metadata`, no second store.
 *
 * The `amr`, `acr`, and `maxAge` options are still *authentication* questions
 * ("was a second factor presented, and how recently?"), not authorization ones.
 * That distinction is what keeps this decorator on the right side of the
 * package's scope line: it never asks what the subject is allowed to do.
 */

export const AUTHENTICATED_KEY = 'auth:authenticated';
export const AUTHORIZATION_KEY = 'auth:authorization';
export const PUBLIC_KEY = 'auth:public';
/** Key under which a class-wide rule is stored. */
export const TYPE_RULE = '$type';

export interface AuthenticatedOptions {
  /** Require every listed RFC 8176 method to appear in `Principal.amr`. */
  amr?: readonly string[];
  /** Require an exact `Principal.acr`. */
  acr?: string;
  /** Re-authentication window in seconds, measured from `Principal.authTime`. */
  maxAge?: number;
  /** Message for the rejection. Kept generic by default. */
  message?: string;
}

type RuleMap = Record<string, AuthenticatedOptions>;

export interface AuthorizeRule<TMetadata = unknown> {
  /** Opaque policy input interpreted only by the authorization manager. */
  readonly metadata: TMetadata;
  /** Pass an absent principal to the manager instead of rejecting with 401. */
  readonly allowAnonymous: boolean;
  /** Per-field manager override. */
  readonly manager?: AuthorizationManager;
}

export interface AuthorizeOptions {
  allowAnonymous?: boolean;
  manager?: AuthorizationManager;
}

type AuthorizationRuleMap = Record<string, AuthorizeRule>;

// biome-ignore lint/suspicious/noExplicitAny: decorators receive arbitrary targets.
type DecoratorTarget = any;

/**
 * Applies to a whole type (as a class decorator) or to a single
 * `@Field` / `@Action` / `@Subscription` (as a property or method decorator).
 */
export function Authenticated(options: AuthenticatedOptions = {}) {
  return (target: DecoratorTarget, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      const map = (getOwnMetadata(AUTHENTICATED_KEY, target) as RuleMap | undefined) ?? {};
      defineMetadata(AUTHENTICATED_KEY, { ...map, [TYPE_RULE]: options }, target);
      return;
    }
    // Member decorators receive the prototype; store there and also on the
    // constructor so lookup works from either direction.
    const owner = typeof target === 'function' ? target : target.constructor;
    const map = (getOwnMetadata(AUTHENTICATED_KEY, owner) as RuleMap | undefined) ?? {};
    defineMetadata(AUTHENTICATED_KEY, { ...map, [String(propertyKey)]: options }, owner);
  };
}

/**
 * Require a policy decision for a type, field, action, or subscription.
 *
 * The first argument is intentionally untyped framework data: applications
 * define their own `{ action, resource, attributes }` vocabulary.
 */
export function Authorize<TMetadata = undefined>(
  metadata?: TMetadata,
  options: AuthorizeOptions = {},
) {
  const rule: AuthorizeRule<TMetadata | undefined> = {
    metadata,
    allowAnonymous: options.allowAnonymous ?? false,
    ...(options.manager ? { manager: options.manager } : {}),
  };

  return (target: DecoratorTarget, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      const map =
        (getOwnMetadata(AUTHORIZATION_KEY, target) as AuthorizationRuleMap | undefined) ?? {};
      defineMetadata(AUTHORIZATION_KEY, { ...map, [TYPE_RULE]: rule }, target);
      return;
    }
    const owner = typeof target === 'function' ? target : target.constructor;
    const map =
      (getOwnMetadata(AUTHORIZATION_KEY, owner) as AuthorizationRuleMap | undefined) ?? {};
    defineMetadata(AUTHORIZATION_KEY, { ...map, [String(propertyKey)]: rule }, owner);
  };
}

/**
 * Make one field public by opting it out of both authentication and
 * authorization declarations, including class-level inheritance.
 */
export function PublicField() {
  return (target: DecoratorTarget, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) return;
    const owner = typeof target === 'function' ? target : target.constructor;
    const map = (getOwnMetadata(PUBLIC_KEY, owner) as Record<string, true> | undefined) ?? {};
    defineMetadata(PUBLIC_KEY, { ...map, [String(propertyKey)]: true }, owner);
  };
}

/**
 * Resolve the rule for one member, walking the prototype chain so a subclass
 * inherits its base's declarations — mirroring how `collectFieldDeclarations`
 * gathers fields in `@di-framework/graphql`.
 */
export function authRuleFor(
  target: DecoratorTarget,
  propertyKey: string,
  fallback: 'public' | 'authenticated' = 'public',
): AuthenticatedOptions | undefined {
  let current: DecoratorTarget = target;
  let typeRule: AuthenticatedOptions | undefined;
  let isPublic = false;

  while (current && current !== Function.prototype && current !== Object.prototype) {
    const publicMap = getOwnMetadata(PUBLIC_KEY, current) as Record<string, true> | undefined;
    if (publicMap?.[propertyKey]) isPublic = true;

    const map = getOwnMetadata(AUTHENTICATED_KEY, current) as RuleMap | undefined;
    if (map) {
      const memberRule = map[propertyKey];
      // A field-level rule is the most specific answer available; stop here.
      if (memberRule) return isPublic ? undefined : memberRule;
      typeRule ??= map[TYPE_RULE];
    }
    current = Object.getPrototypeOf(current);
  }

  if (isPublic) return undefined;
  if (typeRule) return typeRule;
  return fallback === 'authenticated' ? {} : undefined;
}

/** Resolve the most-specific authorization declaration for a member. */
export function authorizationRuleFor(
  target: DecoratorTarget,
  propertyKey: string,
): AuthorizeRule | undefined {
  let current: DecoratorTarget = target;
  let typeRule: AuthorizeRule | undefined;
  let isPublic = false;

  while (current && current !== Function.prototype && current !== Object.prototype) {
    const publicMap = getOwnMetadata(PUBLIC_KEY, current) as Record<string, true> | undefined;
    if (publicMap?.[propertyKey]) isPublic = true;

    const map = getOwnMetadata(AUTHORIZATION_KEY, current) as AuthorizationRuleMap | undefined;
    if (map) {
      const memberRule = map[propertyKey];
      if (memberRule) return isPublic ? undefined : memberRule;
      typeRule ??= map[TYPE_RULE];
    }
    current = Object.getPrototypeOf(current);
  }

  return isPublic ? undefined : typeRule;
}
