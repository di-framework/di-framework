/**
 * Authorization policies and binding boundaries for distributed actors.
 */
import { ActorAuthorizationError } from './errors.js';
import type {
  ActorAuthorizationPolicy,
  ActorBindingRules,
  ActorRpcRequest,
} from './types.js';

export class RuleBasedActorAuthorizationPolicy implements ActorAuthorizationPolicy {
  private readonly rules: ActorBindingRules;

  constructor(rules: ActorBindingRules) {
    this.rules = rules;
  }

  authorize(request: ActorRpcRequest): boolean {
    const { callerId, namespace, actorType, method } = request;

    // 1. Caller boundary check
    if (this.rules.allowedCallers && this.rules.allowedCallers.length > 0) {
      if (!callerId || !this.rules.allowedCallers.includes(callerId)) {
        throw new ActorAuthorizationError(
          actorType,
          method,
          `Caller '${callerId ?? 'anonymous'}' is not authorized.`,
          { callerId, namespace },
        );
      }
    }

    // 2. Namespace boundary check
    if (this.rules.allowedNamespaces && this.rules.allowedNamespaces.length > 0) {
      const ns = namespace ?? 'default';
      if (!this.rules.allowedNamespaces.includes(ns)) {
        throw new ActorAuthorizationError(
          actorType,
          method,
          `Access to namespace '${ns}' is not authorized.`,
          { callerId, namespace: ns },
        );
      }
    }

    // 3. Actor type boundary check
    if (this.rules.allowedActorTypes && this.rules.allowedActorTypes.length > 0) {
      if (!this.rules.allowedActorTypes.includes(actorType)) {
        throw new ActorAuthorizationError(
          actorType,
          method,
          `Actor type '${actorType}' is not authorized.`,
          { callerId, namespace },
        );
      }
    }

    // 4. Method boundary check
    if (this.rules.allowedMethods && this.rules.allowedMethods[actorType]) {
      const allowedMethods = this.rules.allowedMethods[actorType];
      if (!allowedMethods.includes(method)) {
        throw new ActorAuthorizationError(
          actorType,
          method,
          `Method '${method}' on actor '${actorType}' is not authorized.`,
          { callerId, namespace },
        );
      }
    }

    return true;
  }
}

/**
 * Creates an authorization policy enforcing whitelisted binding rules.
 */
export function createActorBindingPolicy(rules: ActorBindingRules): ActorAuthorizationPolicy {
  return new RuleBasedActorAuthorizationPolicy(rules);
}
