import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrCreateActorMetadata } from '../decorators/keys.js';
import type { ActorStorageTransaction } from '../storage/types.js';

export const actorContextStorage = new AsyncLocalStorage<ActorContextInstance>();

export interface ActorContextOptions {
  actorId: string;
  actorKey: string;
  actorType: string;
  storage: ActorStorageTransaction;
  actors: any;
}

export class ActorContextInstance {
  readonly actorId: string;
  readonly actorKey: string;
  readonly actorType: string;
  readonly storage: ActorStorageTransaction;
  readonly actors: any;

  constructor(options: ActorContextOptions) {
    this.actorId = options.actorId;
    this.actorKey = options.actorKey;
    this.actorType = options.actorType;
    this.storage = options.storage;
    this.actors = options.actors;
  }

  /**
   * Underlying database instance when running on a database-backed storage adapter (e.g. SQLite).
   */
  get database(): any {
    if (typeof this.storage.getDatabase === 'function') {
      return this.storage.getDatabase();
    }
    return undefined;
  }
}

function applyActorContextDecorator(
  target: any,
  propertyKey?: string | symbol,
  parameterIndex?: number,
): void {
  const meta = getOrCreateActorMetadata(target);
  if (parameterIndex !== undefined) {
    if (propertyKey === undefined) {
      meta.constructorContextIndex = parameterIndex;
    } else {
      let params = meta.contextParams.get(propertyKey);
      if (!params) {
        params = [];
        meta.contextParams.set(propertyKey, params);
      }
      params.push(parameterIndex);
    }
  } else if (propertyKey !== undefined) {
    meta.contextProperties.add(propertyKey);
    Object.defineProperty(target, propertyKey, {
      get() {
        return ActorContext.current() ?? this.__actorContext;
      },
      set(val) {
        this.__actorContext = val;
      },
      enumerable: true,
      configurable: true,
    });
  }
}

function actorContextHandler(this: any, ...args: any[]): any {
  if (new.target) {
    return new ActorContextInstance(args[0]);
  }

  if (args.length > 0 && (typeof args[0] === 'object' || typeof args[0] === 'function')) {
    const [target, propertyKey, parameterIndex] = args;
    applyActorContextDecorator(target, propertyKey, parameterIndex);
    return;
  }

  return (target: any, propertyKey?: string | symbol, parameterIndex?: number) => {
    applyActorContextDecorator(target, propertyKey, parameterIndex);
  };
}

actorContextHandler.current = (): ActorContextInstance | undefined =>
  actorContextStorage.getStore();

Object.defineProperty(actorContextHandler, Symbol.hasInstance, {
  value: (instance: any) => instance instanceof ActorContextInstance,
});

export interface ActorContextStatic {
  new (options: ActorContextOptions): ActorContextInstance;
  (targetOrEmpty?: any, propertyKey?: string | symbol, parameterIndex?: number): any;
  current(): ActorContextInstance | undefined;
}

export type ActorContext = ActorContextInstance;
export const ActorContext: ActorContextStatic = actorContextHandler as any;
