import type { AuthorizationManager, Principal } from '@di-framework/auth';
import { useContainer } from '@di-framework/core/container';
import type { PolicyAuthorizationMetadata } from './manager.ts';
import { resourceForPolicy } from './registry.ts';

const ACTION = Symbol.for('@di-framework/authz:graphql-resource-action');
const RESOURCE_AUTH = Symbol.for('@di-framework/authz:graphql-resource-auth');

export class GraphQLResourcePolicyError extends Error {
  readonly extensions: { code: string };

  constructor(message = 'Not authorized.', code = 'FORBIDDEN') {
    super(message);
    this.name = 'GraphQLResourcePolicyError';
    this.extensions = { code };
  }
}

export interface GraphQLAuthorizationMetadata extends PolicyAuthorizationMetadata {
  collection?: boolean;
}

export interface GraphQLAuthorizationContext<TMetadata = GraphQLAuthorizationMetadata> {
  readonly transport: 'graphql';
  readonly metadata: TMetadata;
  readonly parent?: unknown;
  readonly args?: Record<string, unknown>;
  readonly ctx?: unknown;
  readonly info?: unknown;
}

export interface GraphQLAuthzDenial {
  resource: string;
  action: string;
  id?: string;
  category?: string;
  ruleIds?: string[];
  reason?: string;
  anonymous?: boolean;
}

export interface GraphQLResourceAuthorizationOptions {
  action?: string;
  idArg?: string | ((args: Record<string, any>, parent: unknown) => string | undefined);
  idField?: string;
  manager?: AuthorizationManager<any> | (() => AuthorizationManager<any>);
  managerToken?: string;
  container?: { resolve<T>(token: string): T; has?(token: string): boolean };
  onDenied?: (denial: GraphQLAuthzDenial) => Error;
}

type PolicyClass = Function;

export function ResourceAction(action: string) {
  if (!action.trim() || !/^[A-Za-z][\w:.-]*$/.test(action)) {
    throw new Error(`Invalid resource action '${action}'`);
  }
  return (target: object, propertyKey: string | symbol) => {
    const value = (target as Record<string | symbol, unknown>)[propertyKey];
    if (typeof value === 'function') {
      (value as any)[ACTION] = action;
    }
  };
}

function inferGraphQLAction(
  fieldName: string,
  optionsAction?: string,
  explicitAction?: string,
): { action: string; collection: boolean } {
  if (explicitAction) return { action: explicitAction, collection: false };
  if (optionsAction) return { action: optionsAction, collection: false };

  const name = fieldName.toLowerCase();
  if (
    name.startsWith('list') ||
    name.startsWith('getmany') ||
    name.startsWith('all') ||
    name.includes('connection')
  ) {
    return { action: 'list', collection: true };
  }
  if (name.startsWith('create') || name.startsWith('add') || name.startsWith('insert')) {
    return { action: 'create', collection: true };
  }
  if (
    name.startsWith('update') ||
    name.startsWith('edit') ||
    name.startsWith('modify') ||
    name.startsWith('set')
  ) {
    return { action: 'update', collection: false };
  }
  if (name.startsWith('delete') || name.startsWith('remove')) {
    return { action: 'delete', collection: false };
  }
  return { action: 'read', collection: false };
}

function resolveResourceId(
  args: Record<string, any>,
  parent: unknown,
  options: GraphQLResourceAuthorizationOptions,
): string | undefined {
  if (typeof options.idArg === 'function') {
    return options.idArg(args, parent);
  }
  if (typeof options.idArg === 'string') {
    const val = args[options.idArg];
    return val !== undefined && val !== null ? String(val) : undefined;
  }
  if (typeof options.idField === 'string') {
    const val = (parent as Record<string, any>)?.[options.idField];
    return val !== undefined && val !== null ? String(val) : undefined;
  }
  const fallback = args['id'] ?? args['idParam'] ?? (parent as Record<string, any>)?.['id'];
  return fallback !== undefined && fallback !== null ? String(fallback) : undefined;
}

export async function evaluateGraphQLResourcePolicy(
  reference: PolicyClass | string,
  parent: unknown,
  args: Record<string, any>,
  ctx: any,
  info: any,
  options: GraphQLResourceAuthorizationOptions = {},
): Promise<void> {
  const resource = typeof reference === 'string' ? reference : resourceForPolicy(reference);
  if (!resource) {
    throw new Error(
      `Policy class '${typeof reference === 'string' ? reference : reference.name}' is not registered`,
    );
  }

  const principal: Principal | undefined = ctx?.user ?? ctx?.principal;
  const fieldName = info?.fieldName ?? 'resolver';
  const explicitAction = (options as any)[ACTION];
  const { action, collection } = inferGraphQLAction(fieldName, options.action, explicitAction);

  const id = resolveResourceId(args, parent, options);

  // Fail closed if member operation lacks resource ID
  if (!collection && action !== 'create' && !id) {
    const denial: GraphQLAuthzDenial = {
      resource,
      action,
      reason: 'resource-id-missing',
      anonymous: !principal,
    };
    if (options.onDenied) throw options.onDenied(denial);
    throw new GraphQLResourcePolicyError('Resource ID is missing or invalid.', 'FORBIDDEN');
  }

  if (!principal) {
    const denial: GraphQLAuthzDenial = {
      resource,
      action,
      id,
      reason: 'unauthenticated',
      anonymous: true,
    };
    if (options.onDenied) throw options.onDenied(denial);
    throw new GraphQLResourcePolicyError('Authentication is required.', 'UNAUTHENTICATED');
  }

  const container = options.container ?? (useContainer() as any);
  let manager: AuthorizationManager<any>;
  if (typeof options.manager === 'function') {
    manager = options.manager();
  } else if (options.manager) {
    manager = options.manager;
  } else {
    const token = options.managerToken ?? '@di-framework/authz:manager';
    manager = container.resolve(token);
  }

  if (!manager) {
    throw new Error('No authorization manager available for GraphQL resource policy evaluation');
  }

  const context: GraphQLAuthorizationContext = {
    transport: 'graphql',
    metadata: {
      resource,
      action,
      id,
      collection,
    },
    parent,
    args,
    ctx,
    info,
  };

  const decision = await manager.authorize(principal, context as any);
  const allowed = typeof decision === 'boolean' ? decision : decision.allowed;

  if (!allowed) {
    const detail = typeof decision === 'object' ? (decision.detail as any) : undefined;
    const denial: GraphQLAuthzDenial = {
      resource,
      action,
      id,
      category: detail?.category,
      ruleIds: detail?.ruleIds,
      reason: typeof decision === 'object' ? (decision as any).reason : 'denied',
      anonymous: false,
    };
    if (options.onDenied) throw options.onDenied(denial);
    throw new GraphQLResourcePolicyError('Not authorized.', 'FORBIDDEN');
  }
}

export function protectGraphQLField<
  TSource = unknown,
  TArgs = Record<string, any>,
  TContext = unknown,
>(
  reference: PolicyClass | string,
  resolver: (source: TSource, args: TArgs, ctx: TContext, info: any) => any,
  options: GraphQLResourceAuthorizationOptions = {},
): (source: TSource, args: TArgs, ctx: TContext, info: any) => Promise<any> {
  return async (source: TSource, args: TArgs, ctx: TContext, info: any) => {
    await evaluateGraphQLResourcePolicy(
      reference,
      source,
      args as Record<string, any>,
      ctx,
      info,
      options,
    );
    return resolver(source, args, ctx, info);
  };
}

export function GraphQLResourceAuthorization(
  reference: PolicyClass | string,
  options: GraphQLResourceAuthorizationOptions = {},
) {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor && typeof descriptor.value === 'function') {
      const original = descriptor.value;
      descriptor.value = async function (...methodArgs: any[]) {
        const [parent, args, ctx, info] = methodArgs;
        await evaluateGraphQLResourcePolicy(reference, parent, args, ctx, info, options);
        return original.apply(this, methodArgs);
      };
      return descriptor;
    }

    if (typeof target === 'function') {
      (target as any)[RESOURCE_AUTH] = { reference, options };
    }
  };
}
