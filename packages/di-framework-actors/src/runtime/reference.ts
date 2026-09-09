import type { ActorRef, Constructor } from '../types.js';

export interface InvocationTarget {
  invoke(
    actorClassOrName: Constructor | string,
    actorKey: string,
    methodName: string,
    args: any[],
    options?: any,
  ): Promise<any>;
}

/**
 * Creates a typed proxy reference to an actor instance.
 */
export function createActorReference<T extends object>(
  actorClassOrName: Constructor<T> | string,
  actorKey: string,
  targetInvoker: InvocationTarget,
  defaultOptions?: any,
): ActorRef<T> {
  const actorType = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
  const compositeId = `${actorType}:${actorKey}`;

  const target = {
    actorKey,
    actorType,
    id: compositeId,
  };

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'actorKey') return actorKey;
      if (prop === 'actorType') return actorType;
      if (prop === 'id') return compositeId;
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') {
        return Reflect.get(obj, prop, receiver);
      }

      return (...args: any[]) => {
        return targetInvoker.invoke(actorClassOrName, actorKey, prop, args, defaultOptions);
      };
    },
  });

  return proxy as unknown as ActorRef<T>;
}
