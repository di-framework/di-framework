import type {
  JsonValue,
  PolicyCondition,
  PolicyDocument,
  PolicyRule,
  ResourcePolicy,
} from './types.ts';

interface DraftRule {
  effect?: 'allow' | 'deny';
  actions: string[];
  conditions: PolicyCondition[];
}
interface DraftPolicy {
  target: Function;
  name: string;
  resource: string;
  rules: Map<string, DraftRule>;
}

export class PolicyRegistry {
  private policies = new Map<Function, DraftPolicy>();

  policy(target: Function, resource: string): void {
    if (!resource.trim()) throw new Error('Policy resource must not be empty');
    const existing = this.policies.get(target);
    if (existing?.resource) throw new Error(`Policy '${target.name}' is already registered`);
    for (const policy of this.policies.values()) {
      if (policy.resource === resource) throw new Error(`Duplicate policy resource '${resource}'`);
    }
    if (existing) existing.resource = resource;
    else this.policies.set(target, { target, name: target.name, resource, rules: new Map() });
  }

  rule(target: Function, method: string, effect: 'allow' | 'deny', actions: string[]): void {
    if (actions.length === 0 || actions.some((action) => !action.trim()))
      throw new Error('Policy actions must not be empty');
    const draft = this.draft(target, method);
    if (draft.effect && draft.effect !== effect)
      throw new Error(`${target.name}.${method} mixes allow and deny`);
    draft.effect = effect;
    draft.actions.push(...actions);
  }

  condition(target: Function, method: string, condition: PolicyCondition): void {
    const paths =
      condition.type === 'owner'
        ? [condition.subjectPath, condition.resourcePath]
        : condition.type === 'equals'
          ? [condition.path]
          : [];
    if (paths.some((path) => !/^(subject|resource)(\.[A-Za-z_$][\w$]*)+$/.test(path)))
      throw new Error(
        `Unsafe attribute path '${paths.find((path) => !/^(subject|resource)(\.[A-Za-z_$][\w$]*)+$/.test(path))}'`,
      );
    if (
      (condition.type === 'has-role' && !condition.roles.length) ||
      (condition.type === 'has-scope' && !condition.scopes.length)
    )
      throw new Error('Condition values must not be empty');
    this.draft(target, method).conditions.push(condition);
  }

  compile(): PolicyDocument {
    const resources = new Set<string>();
    const ids = new Set<string>();
    const policies: ResourcePolicy[] = [];
    for (const policy of [...this.policies.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!policy.resource) throw new Error(`Policy '${policy.name}' is missing @Policy`);
      if (resources.has(policy.resource))
        throw new Error(`Duplicate policy resource '${policy.resource}'`);
      resources.add(policy.resource);
      const rules: PolicyRule[] = [];
      for (const [method, draft] of [...policy.rules].sort(([a], [b]) => a.localeCompare(b))) {
        if (!draft.effect) throw new Error(`${policy.name}.${method} has conditions but no effect`);
        if (!draft.actions.length) throw new Error(`${policy.name}.${method} has no actions`);
        const id = `${policy.name}.${method}`;
        if (ids.has(id)) throw new Error(`Duplicate rule ID '${id}'`);
        ids.add(id);
        rules.push({
          id,
          effect: draft.effect,
          actions: [...new Set(draft.actions)].sort(),
          conditions: draft.conditions,
        });
      }
      policies.push({ name: policy.name, resource: policy.resource, rules });
    }
    return { policies };
  }

  clear(): void {
    this.policies.clear();
  }
  private draft(target: Function, method: string): DraftRule {
    let policy = this.policies.get(target);
    if (!policy) {
      policy = { target, name: target.name, resource: '', rules: new Map() };
      this.policies.set(target, policy);
    }
    let rule = policy.rules.get(method);
    if (!rule) {
      rule = { actions: [], conditions: [] };
      policy.rules.set(method, rule);
    }
    return rule;
  }
}

export const policyRegistry = new PolicyRegistry();

function location(target: object, propertyKey: string | symbol | undefined): [Function, string] {
  if (propertyKey === undefined) throw new Error('Rule decorators may only be used on methods');
  return [target.constructor, String(propertyKey)];
}
export const Policy = (resource: string) => (target: Function) =>
  policyRegistry.policy(target, resource);
export const Allow =
  (...actions: string[]) =>
  (target: object, key?: string | symbol) => {
    const [ctor, method] = location(target, key);
    policyRegistry.rule(ctor, method, 'allow', actions);
  };
export const Deny =
  (...actions: string[]) =>
  (target: object, key?: string | symbol) => {
    const [ctor, method] = location(target, key);
    policyRegistry.rule(ctor, method, 'deny', actions);
  };
export const Owner =
  (options: { subjectPath?: string; resourcePath?: string } = {}) =>
  (target: object, key?: string | symbol) => {
    const [ctor, method] = location(target, key);
    policyRegistry.condition(ctor, method, {
      type: 'owner',
      subjectPath: options.subjectPath ?? 'subject.id',
      resourcePath: options.resourcePath ?? 'resource.ownerId',
    });
  };
export const HasRole = (...roles: string[]) => conditionDecorator({ type: 'has-role', roles });
export const HasScope = (...scopes: string[]) => conditionDecorator({ type: 'has-scope', scopes });
export const Equals = (path: string, value: JsonValue) =>
  conditionDecorator({ type: 'equals', path, value });
function conditionDecorator(condition: PolicyCondition) {
  return (target: object, key?: string | symbol) => {
    const [ctor, method] = location(target, key);
    policyRegistry.condition(ctor, method, condition);
  };
}
export const compilePolicies = (registry: PolicyRegistry = policyRegistry) => registry.compile();
