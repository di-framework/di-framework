import type { ActorMethodOptions } from '../types.js';
import { getOrCreateActorMetadata } from './keys.js';

/**
 * Marks a method on an Actor class as an invocable actor method.
 * Invocations to actor methods are queued in the actor's mailbox and serialized.
 *
 * @example
 * ```ts
 * @Actor()
 * class BankAccountActor {
 *   @ActorMethod()
 *   async deposit(amount: number): Promise<number> { ... }
 * }
 * ```
 */
export function ActorMethod(
  optionsOrTarget?: ActorMethodOptions | any,
  maybePropertyKey?: string | symbol,
  maybeDescriptor?: PropertyDescriptor,
): any {
  if (maybePropertyKey !== undefined) {
    // Called without parentheses: @ActorMethod
    const meta = getOrCreateActorMetadata(optionsOrTarget);
    const methodName = String(maybePropertyKey);
    meta.methods.set(maybePropertyKey, {
      name: methodName,
      methodName: maybePropertyKey,
    });
    return maybeDescriptor;
  }

  // Called with parentheses: @ActorMethod(options?)
  const options = optionsOrTarget as ActorMethodOptions | undefined;
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const meta = getOrCreateActorMetadata(target);
    const exposedName = options?.name ?? String(propertyKey);
    meta.methods.set(propertyKey, {
      name: exposedName,
      methodName: propertyKey,
      options,
    });
    return descriptor;
  };
}
