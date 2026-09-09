import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrCreateActorMetadata } from '../decorators/keys.js';
import { runActorMigrations } from '../migrations/runner.js';
import { InMemoryActorStorage } from '../storage/memory.js';
import type { ActorStorage } from '../storage/types.js';
import {
  ActorMethodNotFoundError,
  ActorNotRegisteredError,
  type ActorOptions,
  type ActorRef,
  type Constructor,
} from '../types.js';
import { ActorContextInstance, actorContextStorage } from './context.js';
import { ActorMailbox } from './mailbox.js';
import { createActorReference, type InvocationTarget } from './reference.js';

export interface ActorRegistration {
  name: string;
  ctor: Constructor;
  options?: ActorOptions;
}

export interface ActorRuntimeOptions {
  storage?: ActorStorage;
  actors?: Constructor[];
}

interface ActorInvocation {
  actorId: string;
  active: boolean;
  parent?: ActorInvocation;
}

export class ActorRuntime implements InvocationTarget {
  private readonly invocationStorage = new AsyncLocalStorage<ActorInvocation>();
  private readonly _storage: ActorStorage;
  private readonly registryByName = new Map<string, ActorRegistration>();
  private readonly registryByCtor = new Map<Constructor, ActorRegistration>();
  private readonly mailboxes = new Map<string, ActorMailbox>();
  private readonly instances = new Map<string, any>();
  private readonly migratedActors = new Set<string>();

  constructor(options: ActorRuntimeOptions = {}) {
    this._storage = options.storage ?? new InMemoryActorStorage();
    if (options.actors) {
      for (const actor of options.actors) {
        this.register(actor);
      }
    }
  }

  get storage(): ActorStorage {
    return this._storage;
  }

  /**
   * Explicitly registers actor classes with the runtime.
   * Supports unit test harnesses without requiring build-time discovery.
   */
  register<T extends object>(
    actorClassOrClasses: Constructor<T> | Constructor<T>[],
    options?: ActorOptions,
  ): this {
    const list = Array.isArray(actorClassOrClasses) ? actorClassOrClasses : [actorClassOrClasses];

    for (const ctor of list) {
      const meta = getOrCreateActorMetadata(ctor);
      const name = options?.name ?? meta.name ?? ctor.name;
      meta.name = name;
      if (options?.namespace) {
        meta.namespace = options.namespace;
      }
      if (options?.migrations) {
        meta.migrations = options.migrations;
      }

      const registration: ActorRegistration = {
        name,
        ctor,
        options,
      };

      this.registryByName.set(name, registration);
      this.registryByCtor.set(ctor, registration);
    }

    return this;
  }

  /**
   * Checks whether an actor class or name is registered.
   */
  isRegistered(actorClassOrName: Constructor | string): boolean {
    if (typeof actorClassOrName === 'string') {
      return this.registryByName.has(actorClassOrName);
    }
    return this.registryByCtor.has(actorClassOrName);
  }

  /**
   * Returns all registered actor definitions.
   */
  getRegisteredActors(): ActorRegistration[] {
    return Array.from(this.registryByName.values());
  }

  /**
   * Returns a typed actor reference proxy for the given actor class and key.
   */
  get<T extends object>(actorClass: Constructor<T>, actorKey: string): ActorRef<T>;
  get<T = any>(actorName: string, actorKey: string): ActorRef<T>;
  get<T extends object>(actorClassOrName: Constructor<T> | string, actorKey: string): ActorRef<T> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }
    return createActorReference<T>(reg.name, actorKey, this);
  }

  private resolveRegistration(
    actorClassOrName: Constructor | string,
  ): ActorRegistration | undefined {
    if (typeof actorClassOrName === 'string') {
      return this.registryByName.get(actorClassOrName);
    }
    return (
      this.registryByCtor.get(actorClassOrName) ?? this.registryByName.get(actorClassOrName.name)
    );
  }

  private getOrCreateMailbox(compositeId: string): ActorMailbox {
    let mb = this.mailboxes.get(compositeId);
    if (!mb) {
      mb = new ActorMailbox();
      this.mailboxes.set(compositeId, mb);
    }
    return mb;
  }

  private async ensureActorMigrated(
    reg: ActorRegistration,
    compositeId: string,
    actorKey: string,
  ): Promise<void> {
    if (this.migratedActors.has(compositeId)) {
      return;
    }

    const meta = getOrCreateActorMetadata(reg.ctor);
    const migrations = reg.options?.migrations ?? meta.migrations ?? (reg.ctor as any).migrations;

    await runActorMigrations({
      actorType: reg.name,
      actorKey,
      compositeId,
      storage: this._storage,
      migrations,
    });

    this.migratedActors.add(compositeId);
  }

  private async getOrCreateInstance(
    reg: ActorRegistration,
    compositeId: string,
    context: ActorContextInstance,
  ): Promise<any> {
    let instance = this.instances.get(compositeId);
    if (!instance) {
      const meta = getOrCreateActorMetadata(reg.ctor);
      const ctor = reg.ctor;

      if (meta.constructorContextIndex !== undefined) {
        const args: any[] = [];
        args[meta.constructorContextIndex] = context;
        instance = new ctor(...args);
      } else if (ctor.length > 0) {
        try {
          instance = new ctor(context);
        } catch {
          instance = new ctor();
        }
      } else {
        instance = new ctor();
      }

      instance.__actorContext = context;
      for (const prop of meta.contextProperties) {
        try {
          instance[prop] = context;
        } catch {
          // Handled by getter
        }
      }

      if (typeof instance.onActivate === 'function') {
        await instance.onActivate();
      }

      this.instances.set(compositeId, instance);
    }
    return instance;
  }

  private getCompositeId(reg: ActorRegistration, actorKey: string): string {
    const meta = getOrCreateActorMetadata(reg.ctor);
    const namespace = reg.options?.namespace ?? meta.namespace;
    return namespace ? `${namespace}:${reg.name}:${actorKey}` : `${reg.name}:${actorKey}`;
  }

  /**
   * Invokes an actor method. Method execution is queued and serialized in the actor's mailbox.
   * Execution occurs within an isolated storage transaction.
   */
  async invoke(
    actorClassOrName: Constructor | string,
    actorKey: string,
    methodName: string,
    args: any[],
  ): Promise<any> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }

    const compositeId = this.getCompositeId(reg, actorKey);
    const parent = this.invocationStorage.getStore();
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.active && ancestor.actorId === compositeId) {
        throw new Error(
          `Reentrant invocation of actor '${compositeId}' is not supported. Call the instance method directly instead.`,
        );
      }
    }
    const mailbox = this.getOrCreateMailbox(compositeId);

    return mailbox.enqueue(() => {
      const invocation: ActorInvocation = { actorId: compositeId, active: true, parent };
      return this.invocationStorage.run(invocation, async () => {
        try {
          await this.ensureMigrations(reg, compositeId);
          const tx = await this._storage.beginTransaction(compositeId);
          const context = new ActorContextInstance({
            actorId: compositeId,
            actorKey,
            actorType: reg.name,
            storage: tx,
            actors: this,
          });

          const instance = await this.getOrCreateInstance(reg, compositeId, context);
          const meta = getOrCreateActorMetadata(reg.ctor);

          // Verify method exists and is callable
          let targetMethodName = methodName;
          let methodOptions: any;

          if (meta.methods.size > 0) {
            const direct = meta.methods.get(methodName);
            if (direct) {
              targetMethodName = String(direct.methodName);
              methodOptions = direct.options;
            } else {
              // Look up by exposed name option
              let matched = false;
              for (const [mName, mMeta] of meta.methods.entries()) {
                if (mMeta.name === methodName) {
                  targetMethodName = String(mName);
                  methodOptions = mMeta.options;
                  matched = true;
                  break;
                }
              }
              if (!matched) {
                throw new ActorMethodNotFoundError(reg.name, methodName);
              }
            }
          }

          if (typeof instance[targetMethodName] !== 'function') {
            throw new ActorMethodNotFoundError(reg.name, methodName);
          }

          // Update context reference on instance
          instance.__actorContext = context;
          for (const prop of meta.contextProperties) {
            try {
              instance[prop] = context;
            } catch {
              // Getter fallback
            }
          }

          // Prepare final arguments (including parameter-injected contexts)
          const finalArgs = [...args];
          const paramIndices = meta.contextParams.get(targetMethodName);
          if (paramIndices) {
            for (const idx of paramIndices) {
              finalArgs[idx] = context;
            }
          }

          try {
            const executeCall = async () => {
              return await actorContextStorage.run(context, () => {
                return instance[targetMethodName].apply(instance, finalArgs);
              });
            };

            let result: any;
            if (methodOptions?.timeout && methodOptions.timeout > 0) {
              let timeoutHandle: any;
              const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(
                    new Error(
                      `Actor method '${reg.name}.${methodName}' timed out after ${methodOptions.timeout}ms.`,
                    ),
                  );
                }, methodOptions.timeout);
              });

              try {
                result = await Promise.race([executeCall(), timeoutPromise]);
              } finally {
                clearTimeout(timeoutHandle);
              }
            } else {
              result = await executeCall();
            }

            await tx.commit();
            return result;
          } catch (error) {
            await tx.rollback();
            throw error;
          }
        } finally {
          invocation.active = false;
        }
      });
    });
  }

  /**
   * Deactivates an active actor instance, calling its onDeactivate hook if implemented.
   */
  async deactivate(actorClassOrName: Constructor | string, actorKey: string): Promise<boolean> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) return false;

    const compositeId = this.getCompositeId(reg, actorKey);
    const instance = this.instances.get(compositeId);
    if (!instance) return false;

    if (typeof instance.onDeactivate === 'function') {
      try {
        await instance.onDeactivate();
      } catch {
        // Silently capture deactivation errors
      }
    }

    this.instances.delete(compositeId);
    this.migratedActors.delete(compositeId);

    const mailbox = this.mailboxes.get(compositeId);
    if (mailbox) {
      mailbox.clear();
      this.mailboxes.delete(compositeId);
    }

    if (typeof this._storage.closeActor === 'function') {
      await this._storage.closeActor(compositeId);
    }

    return true;
  }

  /**
   * Clears all active instances, mailboxes, and storage.
   */
  async clear(): Promise<void> {
    this.migratedActors.clear();
    for (const instance of this.instances.values()) {
      if (typeof instance.onDeactivate === 'function') {
        try {
          await instance.onDeactivate();
        } catch {
          // Ignore
        }
      }
    }
    this.instances.clear();
    for (const mailbox of this.mailboxes.values()) {
      mailbox.clear();
    }
    this.mailboxes.clear();
    if (typeof this._storage.close === 'function') {
      await this._storage.close();
    } else if (typeof (this._storage as any).clearAll === 'function') {
      await (this._storage as any).clearAll();
    }
  }
}

/**
 * Global default ActorRuntime instance.
 */
export const actors = new ActorRuntime();
