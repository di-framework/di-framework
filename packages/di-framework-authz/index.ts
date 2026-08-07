export { parsePolicies, printPolicies } from './src/ebnf.ts';
export { evaluatePolicy } from './src/evaluator.ts';
export {
  type PolicyAuthorizationMetadata,
  type PolicyAuthorizationOptions,
  policyAuthorizationManager,
} from './src/manager.ts';
export {
  Allow,
  compilePolicies,
  Deny,
  Equals,
  HasRole,
  HasScope,
  Owner,
  Policy,
  PolicyRegistry,
  policyRegistry,
  resourceForPolicy,
} from './src/registry.ts';
export type {
  JsonValue,
  PolicyCondition,
  PolicyDecision,
  PolicyDecisionCategory,
  PolicyDocument,
  PolicyRule,
  PolicySubject,
  ResourceLoadContext,
  ResourcePolicy,
  ResourceProvider,
} from './src/types.ts';
