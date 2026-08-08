import type { AuthorizationManager, Principal } from '@di-framework/auth';
import { useContainer } from '@di-framework/core/container';
import { parsePolicies } from './ebnf.ts';
import { evaluatePolicy } from './evaluator.ts';
import { compilePolicies } from './registry.ts';
import type { PolicyDecision, PolicyDocument, PolicySubject, ResourceProvider } from './types.ts';

export interface PolicyAuthorizationMetadata {
  resource: string;
  action: string;
  id?: string;
  idParam?: string;
  collection?: boolean;
}
type ProviderClass = new (...args: any[]) => ResourceProvider;
export interface PolicyContainer {
  resolve<T>(token: string | ProviderClass): T;
  has?(token: string | ProviderClass): boolean;
}
export interface PolicyAuthorizationOptions {
  /**
   * Policy source. When omitted, the decorator registry is compiled once when
   * the manager is created, after policy modules should have been imported.
   */
  policies?: string | PolicyDocument;
  providers: Record<string, ResourceProvider | ProviderClass | string>;
  container?: PolicyContainer;
  mapSubject?: (principal: Principal) => PolicySubject;
}
function defaultSubject(principal: Principal): PolicySubject {
  const roles = principal.claims?.roles;
  return {
    id: principal.sub,
    scopes: [...(principal.scope ?? [])],
    roles:
      Array.isArray(roles) && roles.every((role) => typeof role === 'string') ? [...roles] : [],
    claims: { ...(principal.claims ?? {}) },
  };
}
function isProvider(value: unknown): value is ResourceProvider {
  return (
    !!value && typeof value === 'object' && typeof (value as ResourceProvider).load === 'function'
  );
}
export function policyAuthorizationManager(
  options: PolicyAuthorizationOptions,
): AuthorizationManager<any> {
  if (!options?.providers) throw new Error('Policy providers configuration is required');
  const document =
    typeof options.policies === 'string'
      ? parsePolicies(options.policies)
      : (options.policies ?? compilePolicies());
  const container = options.container ?? (useContainer() as unknown as PolicyContainer);
  return {
    async authorize(principal, context) {
      const metadata = context.metadata;
      if (!metadata?.resource || !metadata.action)
        throw new Error('Resource authorization metadata is required');
      if (!document.policies.some((policy) => policy.resource === metadata.resource))
        throw new Error(`No policy configured for resource '${metadata.resource}'`);
      if (!principal) return decision(false, 'no-matching-allow', []);
      let value: unknown;
      if (!metadata.collection) {
        const requestId =
          metadata.id ??
          (context.request as Request & { params?: Record<string, string> }).params?.[
            metadata.idParam ?? 'id'
          ];
        if (!requestId) return decision(false, 'resource-unavailable', []);
        const configured = options.providers[metadata.resource];
        if (!configured)
          throw new Error(`No resource provider configured for '${metadata.resource}'`);
        const resolved: unknown = isProvider(configured)
          ? configured
          : container.resolve(configured as string | ProviderClass);
        if (!isProvider(resolved))
          throw new TypeError(`Provider for '${metadata.resource}' does not implement load()`);
        value = await resolved.load(requestId, {
          principal,
          request: context.request,
          action: metadata.action,
          resource: metadata.resource,
        });
        if (value === null || value === undefined)
          return decision(false, 'resource-unavailable', []);
      }
      const result = evaluatePolicy(document, {
        resource: metadata.resource,
        action: metadata.action,
        subject: (options.mapSubject ?? defaultSubject)(principal),
        value,
      });
      return decision(result.allowed, result.category, result.ruleIds);
    },
  };
}
function decision(allowed: boolean, category: PolicyDecision['category'], ruleIds: string[]) {
  const detail: PolicyDecision = { allowed, category, ruleIds: [...ruleIds].sort() };
  return allowed
    ? { allowed: true as const, detail }
    : { allowed: false as const, reason: category, detail };
}
