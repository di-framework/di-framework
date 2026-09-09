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
import {
  ActorDeadlineExceededError,
  ActorNotOwnerError,
} from '../distributed/errors.js';
import type {
  ActorAuthorizationPolicy,
  ActorOwnershipRecord,
  ActorRpcRequest,
  InvokeOptions,
} from '../distributed/types.js';
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
  /**
   * Unique identity for this host/runtime node.
   */
  ownerId?: string;
  /**
   * Maximum queue length for actor mailboxes before rejecting with backpressure.
   */
  maxMailboxSize?: number;
  /**
   * Authorization policy governing callers, namespaces, and methods.
   */
  authorizationPolicy?: ActorAuthorizationPolicy;
  /**
   * Automatically acquire ownership on invocation if ownerId is configured.
   */
  autoAcquireOwnership?: boolean;
  /**
   * Lease duration in ms for actor ownership.
   */
  leaseTtlMs?: number;
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
  private readonly inFlightRequests = new Map<string, Promise<any>>();
  readonly ownerId?: string;
  readonly maxMailboxSize?: number;
  readonly authorizationPolicy?: ActorAuthorizationPolicy;
  readonly autoAcquireOwnership: boolean;
  readonly leaseTtlMs?: number;

  constructor(options: ActorRuntimeOptions = {}) {
    this._storage = options.storage ?? new InMemoryActorStorage();
    this.ownerId = options.ownerId;
    this.maxMailboxSize = options.maxMailboxSize;
    this.authorizationPolicy = options.authorizationPolicy;
    this.autoAcquireOwnership = options.autoAcquireOwnership ?? (options.ownerId !== undefined);
    this.leaseTtlMs = options.leaseTtlMs;

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
  get<T extends object>(
    actorClass: Constructor<T>,
    actorKey: string,
    options?: InvokeOptions,
  ): ActorRef<T>;
  get<T = any>(actorName: string, actorKey: string, options?: InvokeOptions): ActorRef<T>;
  get<T extends object>(
    actorClassOrName: Constructor<T> | string,
    actorKey: string,
    options?: InvokeOptions,
  ): ActorRef<T> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }
    return createActorReference<T>(reg.name, actorKey, this, options);
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
      mb = new ActorMailbox({
        maxQueueLength: this.maxMailboxSize,
        actorId: compositeId,
      });
      this.mailboxes.set(compositeId, mb);
    }
    return mb;
  }

  async acquireActorOwnership(
    actorClassOrName: Constructor | string,
    actorKey: string,
    options?: { leaseTtlMs?: number; force?: boolean; namespace?: string },
  ): Promise<ActorOwnershipRecord> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }
    const compositeId = this.getCompositeId(reg, actorKey, options?.namespace);
    if (typeof this._storage.acquireOwnership !== 'function') {
      throw new Error('Storage adapter does not support acquireOwnership.');
    }
    const owner = this.ownerId ?? 'default-owner';
    return await this._storage.acquireOwnership(compositeId, owner, {
      leaseTtlMs: options?.leaseTtlMs,
      force: options?.force,
    });
  }

  async getActorOwnership(
    actorClassOrName: Constructor | string,
    actorKey: string,
    options?: { namespace?: string },
  ): Promise<ActorOwnershipRecord | null> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }
    const compositeId = this.getCompositeId(reg, actorKey, options?.namespace);
    if (typeof this._storage.getOwnership !== 'function') {
      return null;
    }
    return await this._storage.getOwnership(compositeId);
  }

  async releaseActorOwnership(
    actorClassOrName: Constructor | string,
    actorKey: string,
  ): Promise<boolean> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) return false;
    const compositeId = this.getCompositeId(reg, actorKey);
    if (typeof this._storage.releaseOwnership !== 'function') {
      return false;
    }
    const owner = this.ownerId ?? 'default-owner';
    return await this._storage.releaseOwnership(compositeId, owner);
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

  private getCompositeId(
    reg: ActorRegistration,
    actorKey: string,
    customNamespace?: string,
  ): string {
    const meta = getOrCreateActorMetadata(reg.ctor);
    const namespace = customNamespace ?? reg.options?.namespace ?? meta.namespace;
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
    options?: InvokeOptions,
  ): Promise<any> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }

    const compositeId = this.getCompositeId(reg, actorKey, options?.namespace);

    const parent = this.invocationStorage.getStore();
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.active && ancestor.actorId === compositeId) {
        throw new Error(
          `Reentrant invocation of actor '${compositeId}' is not supported. Call the instance method directly instead.`,
        );
      }
    }

    // 1. Check deadline
    if (options?.deadline !== undefined && Date.now() > options.deadline) {
      throw new ActorDeadlineExceededError(compositeId, options.deadline, options.requestId);
    }

    // 2. Check authorization boundaries
    if (this.authorizationPolicy) {
      const meta = getOrCreateActorMetadata(reg.ctor);
      const req: ActorRpcRequest = {
        requestId: options?.requestId ?? 'local',
        callerId: options?.callerId,
        namespace: options?.namespace ?? reg.options?.namespace ?? meta.namespace,
        actorType: reg.name,
        actorKey,
        method: methodName,
        args,
        deadline: options?.deadline,
        expectedGeneration: options?.generation,
      };
      this.authorizationPolicy.authorize(req);
    }

    // 3. Check deduplication / idempotency
    if (options?.requestId) {
      const inFlightKey = `${compositeId}::${options.requestId}`;
      const inFlight = this.inFlightRequests.get(inFlightKey);
      if (inFlight) {
        return await inFlight;
      }

      const committed = await this._storage.getIdempotencyRecord?.(compositeId, options.requestId);
      if (committed) {
        const resp = committed.response as any;
        return resp && typeof resp === 'object' && 'result' in resp ? resp.result : resp;
      }
    }

    const mailbox = this.getOrCreateMailbox(compositeId);

    const executeInvocation = async () => {
      return mailbox.enqueue(() => {
        const invocation: ActorInvocation = { actorId: compositeId, active: true, parent };
        return this.invocationStorage.run(invocation, async () => {
          try {
        // Re-check deadline after potentially waiting in queue
        if (options?.deadline !== undefined && Date.now() > options.deadline) {
          throw new ActorDeadlineExceededError(compositeId, options.deadline, options.requestId);
        }

        // Re-check idempotency cache after queue wait
        if (options?.requestId) {
          const committed = await this._storage.getIdempotencyRecord?.(compositeId, options.requestId);
          if (committed) {
            const resp = committed.response as any;
            return resp && typeof resp === 'object' && 'result' in resp ? resp.result : resp;
          }
        }

        // Ensure migrations are applied before allowing activation or calls
        await this.ensureActorMigrated(reg, compositeId, actorKey);

        // Resolve ownership and fencing generation
        let generation = options?.generation;
        if (this.ownerId && typeof this._storage.acquireOwnership === 'function') {
          if (this.autoAcquireOwnership) {
            const rec = await this._storage.acquireOwnership(compositeId, this.ownerId, {
              leaseTtlMs: this.leaseTtlMs,
            });
            generation = rec.generation;
          } else {
            const current = await this._storage.getOwnership?.(compositeId);
            if (current) {
              if (current.ownerId !== this.ownerId) {
                const isExpired = current.leaseExpiresAt != null && current.leaseExpiresAt < Date.now();
                if (!isExpired) {
                  throw new ActorNotOwnerError(compositeId, current.ownerId);
                }
              }
              generation = current.generation;
            }
          }
        }

        // Open transaction with fencing token
        const tx = await this._storage.beginTransaction(compositeId, {
          ownerId: this.ownerId,
          generation,
        });
          const context = new ActorContextInstance({
            actorId: compositeId,
            actorKey,
            actorType: reg.name,
            storage: tx,
            actors: this,
          });

          const wasActive = this.instances.has(compositeId);
          let timedOut = false;
          try {
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
                  timedOut = true;
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

            if (options?.requestId && typeof tx.setIdempotencyRecord === 'function') {
              await tx.setIdempotencyRecord(options.requestId, { result });
            }
            await tx.commit();
            return result;
          } catch (error) {
            if (!wasActive || timedOut) this.instances.delete(compositeId);
            await tx.rollback();
            throw error;
          }
        } finally {
          invocation.active = false;
        }
      });
      });
    };

    if (options?.requestId) {
      const inFlightKey = `${compositeId}::${options.requestId}`;
      const promise = executeInvocation().finally(() => {
        this.inFlightRequests.delete(inFlightKey);
      });
      this.inFlightRequests.set(inFlightKey, promise);
      return await promise;
    }

    return await executeInvocation();
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
