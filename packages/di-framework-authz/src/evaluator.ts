import type {
  JsonValue,
  PolicyCondition,
  PolicyDecision,
  PolicyDocument,
  PolicySubject,
} from './types.ts';

const SAFE_PATH = /^(subject|resource)(\.[A-Za-z_$][\w$]*)+$/;
function readPath(path: string, subject: PolicySubject, resource: unknown): unknown {
  if (!SAFE_PATH.test(path)) return undefined;
  const parts = path.split('.');
  let value: unknown = parts.shift() === 'subject' ? subject : resource;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function structuralEqual(a: unknown, b: JsonValue): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => structuralEqual(v, b[i] as JsonValue));
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ak = Object.keys(a as object).sort(),
      bk = Object.keys(b).sort();
    return (
      ak.length === bk.length &&
      ak.every(
        (k, i) =>
          k === bk[i] && structuralEqual((a as Record<string, unknown>)[k], b[k] as JsonValue),
      )
    );
  }
  return false;
}
function matches(condition: PolicyCondition, subject: PolicySubject, resource: unknown): boolean {
  switch (condition.type) {
    case 'owner': {
      const left = readPath(condition.subjectPath, subject, resource);
      return (
        left !== undefined &&
        structuralEqual(left, readPath(condition.resourcePath, subject, resource) as JsonValue)
      );
    }
    case 'has-role':
      return condition.roles.some((role) => subject.roles.includes(role));
    case 'has-scope':
      return condition.scopes.every((scope) => subject.scopes.includes(scope));
    case 'equals': {
      const actual = readPath(condition.path, subject, resource);
      return actual !== undefined && structuralEqual(actual, condition.value);
    }
  }
}
export function evaluatePolicy(
  document: PolicyDocument,
  input: { resource: string; action: string; subject: PolicySubject; value?: unknown },
): PolicyDecision {
  const policy = document.policies.find((item) => item.resource === input.resource);
  if (!policy) throw new Error(`No policy configured for resource '${input.resource}'`);
  const applicable = policy.rules.filter(
    (rule) =>
      rule.actions.includes(input.action) &&
      rule.conditions.every((c) => matches(c, input.subject, input.value)),
  );
  const denies = applicable
    .filter((rule) => rule.effect === 'deny')
    .map((rule) => rule.id)
    .sort();
  if (denies.length) return { allowed: false, category: 'explicit-deny', ruleIds: denies };
  const allows = applicable
    .filter((rule) => rule.effect === 'allow')
    .map((rule) => rule.id)
    .sort();
  return allows.length
    ? { allowed: true, category: 'allow-rule-matched', ruleIds: allows }
    : { allowed: false, category: 'no-matching-allow', ruleIds: [] };
}
