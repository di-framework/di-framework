import type { ResolvedField, SemanticSchema } from '@di-framework/graphql';
import { defaultFieldResolver } from 'graphql';
import {
  type AuthorizationContext,
  type AuthorizationManager,
  resolveAuthorizationManager,
} from '../authorization.ts';
import { AuthError } from '../errors.ts';
import { hasAmr, type Principal } from '../principal.ts';
import type { AuthContainer } from '../types.ts';
import { type AuthGraphQLContext, requirePrincipal } from './context.ts';
import {
  type AuthenticatedOptions,
  type AuthorizeRule,
  authorizationRuleFor,
  authRuleFor,
} from './decorators.ts';

/**
 * Enforce `@Authenticated()` by post-processing the built schema.
 *
 * This needs **no change to `@di-framework/graphql`**, which is why it is the v1
 * mechanism. It is possible only because `SemanticSchema.graph` exposes
 * `field.source.target` and `field.source.propertyKey` — without them there
 * would be no way to map an executable field back to the class that declared it,
 * since `extensions.diFramework` carries only `{ context, batch, holder }`.
 *
 * Mutating `field.resolve` on a materialised `GraphQLField` works because
 * graphql-js reads `fieldDef.resolve` at execution time, and `getFields()` is
 * memoised so the mutation sticks. Iterating `graph.objects` rather than walking
 * the schema's reachability graph also covers types that are only reachable
 * through the schema's `types` array.
 *
 * Known limitation: `printSDL` renders from the graph, not the schema, so
 * `@authenticated` does not appear in the printed SDL. The SDL describes the
 * shape; the executable schema enforces access.
 */

export interface ProtectSchemaOptions {
  /**
   * `'authenticated'` protects every field unless explicitly marked public.
   * Default `'public'` — opt in per field or per type.
   */
  default?: 'public' | 'authenticated';
  /** Replace the rejection. Must throw. */
  onDeny?: (field: ResolvedField, context: AuthGraphQLContext, rule: AuthenticatedOptions) => never;
  /** Explicit default authorization manager, or a factory. Resolved from DI when omitted. */
  manager?:
    | AuthorizationManager<GraphQLAuthorizationContext>
    | (() => AuthorizationManager<GraphQLAuthorizationContext>);
  managerToken?: string;
  container?: AuthContainer;
  /** Observe or replace a policy denial. Must throw. */
  onForbidden?: (
    field: ResolvedField,
    context: AuthGraphQLContext,
    rule: AuthorizeRule,
    error: AuthError,
  ) => never;
  now?: () => number;
}

/** Context supplied to a manager for a GraphQL field or subscription. */
export interface GraphQLAuthorizationContext<TMetadata = unknown>
  extends AuthorizationContext<TMetadata> {
  readonly transport: 'graphql';
  readonly field: ResolvedField;
  readonly phase: 'resolve' | 'subscribe';
  readonly parent: unknown;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: AuthGraphQLContext;
  readonly info: unknown;
}

/**
 * Check the authentication *strength* a field requires.
 *
 * Still authentication, not authorization: these ask how the subject proved
 * their identity and how recently, never what they may do with it.
 */
export function assertAuthStrength(
  principal: Principal,
  rule: AuthenticatedOptions,
  now: () => number,
): void {
  if (rule.amr && !hasAmr(principal, rule.amr)) {
    throw new AuthError(
      `Field requires amr [${rule.amr.join(', ')}]; principal has [${(principal.amr ?? []).join(', ')}]`,
      {
        code: 'invalid_credentials',
        publicMessage: rule.message ?? 'Stronger authentication required',
      },
    ).redacted();
  }
  if (rule.acr !== undefined && principal.acr !== rule.acr) {
    throw new AuthError(
      `Field requires acr '${rule.acr}'; principal has '${principal.acr ?? '(none)'}'`,
      {
        code: 'invalid_credentials',
        publicMessage: rule.message ?? 'Stronger authentication required',
      },
    ).redacted();
  }
  if (rule.maxAge !== undefined && principal.authTime + rule.maxAge < now()) {
    throw new AuthError(
      `Field requires authentication within ${rule.maxAge}s; authTime is ${principal.authTime}`,
      { code: 'session_expired', publicMessage: rule.message ?? 'Please re-authenticate' },
    ).redacted();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: graphql-js resolvers are variadic and untyped here.
type AnyResolver = (...args: any[]) => any;

interface FieldMap {
  // biome-ignore lint/suspicious/noExplicitAny: graphql-js field configs are open.
  [name: string]: any;
}

interface ObjectTypeLike {
  getFields(): FieldMap;
}

/**
 * Structural check rather than `instanceof GraphQLObjectType`.
 *
 * Two copies of graphql-js in one dependency tree — trivially arrived at when an
 * application pins 16 and a library pins 17 — make `instanceof` return false for
 * a perfectly good object type. The failure is silent: every field simply goes
 * unprotected. Duck-typing on `getFields` cannot fail that way.
 */
function isObjectType(type: unknown): type is ObjectTypeLike {
  return (
    typeof type === 'object' &&
    type !== null &&
    typeof (type as ObjectTypeLike).getFields === 'function' &&
    // Interfaces and input objects also have getFields; only object types have
    // resolvers to wrap, and they are the only ones the graph reports here.
    !('parseValue' in type)
  );
}

export function protectSchema(
  api: SemanticSchema,
  options: ProtectSchemaOptions = {},
): SemanticSchema {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fallback = options.default ?? 'public';

  const guard = (
    field: ResolvedField,
    authRule: AuthenticatedOptions | undefined,
    authorizationRule: AuthorizeRule | undefined,
    phase: 'resolve' | 'subscribe',
    inner: AnyResolver,
  ): AnyResolver =>
    // biome-ignore lint/suspicious/noExplicitAny: positional graphql-js signature.
    async function guarded(this: unknown, parent: any, args: any, context: any, info: any) {
      const ctx = context as AuthGraphQLContext;
      if (authRule) {
        if (!ctx?.principal && options.onDeny) options.onDeny(field, ctx, authRule);
        const principal = requirePrincipal(ctx);
        assertAuthStrength(principal, authRule, now);
      }

      if (authorizationRule) {
        const principal = ctx?.principal;
        if (!principal && !authorizationRule.allowAnonymous) {
          if (options.onDeny) options.onDeny(field, ctx, {});
          requirePrincipal(ctx);
        }

        const manager = resolveAuthorizationManager<GraphQLAuthorizationContext>({
          ...(authorizationRule.manager
            ? {
                manager:
                  authorizationRule.manager as AuthorizationManager<GraphQLAuthorizationContext>,
              }
            : options.manager
              ? { manager: options.manager }
              : {}),
          ...(options.managerToken ? { managerToken: options.managerToken } : {}),
          ...(options.container ? { container: options.container } : {}),
        });
        const result = await manager.authorize(principal, {
          transport: 'graphql',
          metadata: authorizationRule.metadata,
          field,
          phase,
          parent,
          args,
          context: ctx,
          info,
        });
        if (!result.allowed) {
          const error = AuthError.forbidden(
            result.reason ?? 'Authorization manager denied GraphQL field access',
            result.reason === undefined ? undefined : { reason: result.reason },
          );
          if (options.onForbidden) options.onForbidden(field, ctx, authorizationRule, error);
          throw error.redacted();
        }
      }

      return inner.call(this, parent, args, context, info);
    };

  const visit = (
    typeName: string,
    fields: readonly ResolvedField[],
    isSubscriptionRoot: boolean,
  ): void => {
    const type: unknown = api.schema.getType(typeName);
    if (!isObjectType(type)) return;
    // Forces the lazy thunk once; every later read sees the mutated objects.
    const executable: FieldMap = type.getFields();

    for (const field of fields) {
      const rule = authRuleFor(field.source.target, field.source.propertyKey, fallback);
      const authorizationRule = authorizationRuleFor(field.source.target, field.source.propertyKey);
      if (!rule && !authorizationRule) continue;

      const target = executable[field.name];
      if (!target) continue;

      if (isSubscriptionRoot) {
        // Wrap `subscribe`, not `resolve`. Guarding only `resolve` would let the
        // event stream be established first and fail on individual payloads —
        // the connection itself must be refused.
        const subscribe = (target as { subscribe?: AnyResolver }).subscribe;
        if (typeof subscribe === 'function') {
          (target as { subscribe?: AnyResolver }).subscribe = guard(
            field,
            rule,
            authorizationRule,
            'subscribe',
            subscribe,
          );
        }
      }

      const resolve = (target.resolve ?? defaultFieldResolver) as AnyResolver;
      target.resolve = guard(
        field,
        rule,
        authorizationRule,
        'resolve',
        resolve,
      ) as typeof target.resolve;
      target.extensions = {
        ...target.extensions,
        diFrameworkAuth: {
          ...(rule ? { authenticated: true, rule } : {}),
          ...(authorizationRule ? { authorized: true, authorizationRule } : {}),
        },
      };
    }
  };

  visit('Query', api.graph.query.fields, false);
  if (api.graph.mutation) visit('Mutation', api.graph.mutation.fields, false);
  if (api.graph.subscription) visit('Subscription', api.graph.subscription.fields, true);
  for (const object of api.graph.objects) visit(object.name, object.fields, false);

  return api;
}
