import type { AuthorizationManager } from '@di-framework/auth';
import {
  DEFERRED_AUTHORIZATION,
  type DeferredAuthorizationBinder,
  type HttpAuthorizationContext,
} from '@di-framework/auth/http';
import type { PolicyAuthorizationMetadata } from './manager.ts';
import { compilePolicies } from './registry.ts';

const ACTION = Symbol.for('@di-framework/authz:resource-action');
type Handler = Function & {
  path?: string;
  method?: string;
  [ACTION]?: string;
  [DEFERRED_AUTHORIZATION]?: DeferredAuthorizationBinder;
};
type PolicyClass = Function;
export interface ResourceAuthorizationOptions {
  idParam?: string;
  manager?:
    | AuthorizationManager<HttpAuthorizationContext<PolicyAuthorizationMetadata>>
    | (() => AuthorizationManager<HttpAuthorizationContext<PolicyAuthorizationMetadata>>);
  managerToken?: string;
  container?: { resolve<T>(token: string): T; has?(token: string): boolean };
  onDenied?: (request: Request, error: unknown) => Response | Promise<Response>;
}
const knownActions = new Set(['list', 'read', 'create', 'update', 'delete']);
function infer(handler: Handler, idParam: string): { action: string; collection: boolean } {
  const method = handler.method?.toLowerCase();
  const path = handler.path;
  if (!method || !path)
    throw new Error('Resource authorization requires a withAuthRoutes static route');
  const params = [...path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  if (params.some((param) => param !== idParam) || params.length > 1)
    throw new Error(`Route '${path}' has an unsupported resource path`);
  const member = params.length === 1;
  if (handler[ACTION]) return { action: handler[ACTION], collection: !member };
  if (method === 'get') return { action: member ? 'read' : 'list', collection: !member };
  if (method === 'post' && !member) return { action: 'create', collection: true };
  if ((method === 'put' || method === 'patch') && member)
    return { action: 'update', collection: false };
  if (method === 'delete' && member) return { action: 'delete', collection: false };
  throw new Error(
    `Cannot infer a resource action for ${method.toUpperCase()} ${path}; add @ResourceAction`,
  );
}
export function ResourceAction(action: string) {
  if (!action.trim() || !/^[A-Za-z][\w:.-]*$/.test(action))
    throw new Error(`Unknown resource action '${action}'`);
  return (target: object, propertyKey: string | symbol) => {
    const value = (target as Record<string | symbol, unknown>)[propertyKey];
    if (typeof value !== 'function')
      throw new Error('@ResourceAction must decorate an initialized static route property');
    (value as Handler)[ACTION] = action;
  };
}
export function ResourceAuthorization(
  reference: PolicyClass | string,
  options: ResourceAuthorizationOptions = {},
) {
  return (target: Function) => {
    if (!(target as Handler & { isController?: boolean }).isController)
      throw new Error('@ResourceAuthorization must be stacked above @Controller');
    const resource =
      typeof reference === 'string'
        ? reference
        : compilePolicies().policies.find((p) => p.name === reference.name)?.resource;
    if (!resource)
      throw new Error(
        `Policy class '${typeof reference === 'string' ? reference : reference.name}' is not registered`,
      );
    const idParam = options.idParam ?? 'id';
    const parent = Object.getPrototypeOf(target);
    if (
      parent &&
      parent !== Function.prototype &&
      Object.values(parent).some((value) => typeof value === 'function' && (value as Handler).path)
    )
      throw new Error('Inherited resource routes are not supported');
    const routes = Object.entries(target).filter(
      ([, value]) => typeof value === 'function' && !!(value as Handler).path,
    ) as [string, Handler][];
    if (!routes.length) throw new Error('@ResourceAuthorization requires direct static routes');
    const seen = new Set<Handler>();
    for (const [name, handler] of routes) {
      if (seen.has(handler)) throw new Error(`Aliased route '${name}' is not supported`);
      seen.add(handler);
      const bind = handler[DEFERRED_AUTHORIZATION];
      if (!bind) throw new Error(`Route '${name}' was not created by withAuthRoutes`);
      const inferred = infer(handler, idParam);
      if (!knownActions.has(inferred.action) && !handler[ACTION])
        throw new Error(`Unknown inferred action '${inferred.action}'`);
      bind({
        ...(options.manager ? { manager: options.manager } : {}),
        ...(options.managerToken ? { managerToken: options.managerToken } : {}),
        ...(options.container ? { container: options.container } : {}),
        ...(options.onDenied ? { onDenied: options.onDenied as never } : {}),
        metadata: {
          resource,
          action: inferred.action,
          collection: inferred.collection,
          ...(!inferred.collection ? { idParam } : {}),
        },
      });
    }
  };
}
