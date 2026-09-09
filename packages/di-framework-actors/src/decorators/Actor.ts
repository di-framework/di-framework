import type { ActorOptions, Constructor } from '../types.js';
import { getOrCreateActorMetadata } from './keys.js';

/**
 * Marks a class as an Actor in di-framework.
 *
 * @example
 * ```ts
 * @Actor()
 * class CounterActor {
 *   @ActorMethod()
 *   async increment(step: number = 1): Promise<number> { ... }
 * }
 * ```
 */
export function Actor(targetOrOptions?: Constructor | ActorOptions | string): any {
  if (typeof targetOrOptions === 'function') {
    // Called without parentheses: @Actor
    const meta = getOrCreateActorMetadata(targetOrOptions);
    meta.name = targetOrOptions.name;
    return targetOrOptions;
  }

  // Called with parentheses: @Actor() or @Actor({ name: '...' })
  return (target: Constructor) => {
    const meta = getOrCreateActorMetadata(target);
    if (typeof targetOrOptions === 'string') {
      meta.name = targetOrOptions;
    } else if (targetOrOptions && typeof targetOrOptions === 'object') {
      if (targetOrOptions.name) {
        meta.name = targetOrOptions.name;
      }
      if (targetOrOptions.namespace) {
        meta.namespace = targetOrOptions.namespace;
      }
      if (targetOrOptions.migrations) {
        meta.migrations = targetOrOptions.migrations;
      }
    } else {
      meta.name = target.name;
    }
    return target;
  };
}
