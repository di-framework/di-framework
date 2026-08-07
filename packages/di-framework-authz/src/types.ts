export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PolicyCondition =
  | { type: 'owner'; subjectPath: string; resourcePath: string }
  | { type: 'has-role'; roles: string[] }
  | { type: 'has-scope'; scopes: string[] }
  | { type: 'equals'; path: string; value: JsonValue };

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny';
  actions: string[];
  conditions: PolicyCondition[];
}

export interface ResourcePolicy {
  name: string;
  resource: string;
  rules: PolicyRule[];
}

export interface PolicyDocument {
  policies: ResourcePolicy[];
}
export interface PolicySubject {
  id?: string;
  roles: string[];
  scopes: string[];
  claims: Record<string, unknown>;
}
export type PolicyDecisionCategory =
  | 'allow-rule-matched'
  | 'explicit-deny'
  | 'no-matching-allow'
  | 'resource-unavailable';
export interface PolicyDecision {
  allowed: boolean;
  category: PolicyDecisionCategory;
  ruleIds: string[];
}
export interface ResourceLoadContext {
  principal: unknown;
  request?: Request;
  action: string;
  resource: string;
}
export interface ResourceProvider<T = unknown> {
  load(
    id: string,
    context: ResourceLoadContext,
  ): T | null | undefined | Promise<T | null | undefined>;
}
