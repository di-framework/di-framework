import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrCreateActorMetadata } from "../decorators/keys.js";
import { type ActorDiscoveryOptions, discoverActorClasses, type DiscoveredActor } from "../dev/discovery.js";
import { runActorMigrations } from "../migrations/runner.js";
import { InMemoryActorStorage } from "../storage/memory.js";
import { actorIdentityToPath, parseActorIdentity } from "../storage/path.js";
import { SqliteActorStorage } from "../storage/sqlite.js";
import type { ActorStorage } from "../storage/types.js";
import {
  ActorAmbiguityError,
  type ActorDetailedInspection,
  type ActorInspectionInfo,
  ActorMethodNotFoundError,
  ActorNotRegisteredError,
  type ActorOptions,
  type ActorRef,
  ActorReloadError,
  type ActorReloadOptions,
  type ActorReloadResult,
  type ActorResetOptions,
  type ActorResetResult,
  type Constructor,
} from '../types.js';
import { ActorContextInstance, actorContextStorage } from './context.js';
import { ActorMailbox } from './mailbox.js';
import { createActorReference, type InvocationTarget } from './reference.js';

export interface ActorRegistration {
  name: string;
  namespace?: string;
  ctor: Constructor;
  options?: ActorOptions;
}

export interface ActorRuntimeOptions {
  storage?: ActorStorage;
  actors?: Constructor[];
  namespace?: string;
}

interface ActorInvocation {
  actorId: string;
  active: boolean;
  parent?: ActorInvocation;
}

export class ActorRuntime implements InvocationTarget {
  private readonly invocationStorage = new AsyncLocalStorage<ActorInvocation>();
  private readonly _storage: ActorStorage;
  private readonly defaultNamespace?: string;
  private readonly registryByName = new Map<string, ActorRegistration | "ambiguous">();
  private readonly registryByQualifiedName = new Map<string, ActorRegistration>();
  private readonly registryByCtor = new Map<Constructor, ActorRegistration>();
  private readonly actorsByNameGroup = new Map<string, ActorRegistration[]>();
  private readonly mailboxes = new Map<string, ActorMailbox>();
  private readonly instances = new Map<string, any>();
  private readonly migratedActors = new Set<string>();
  private readonly migrationFailures = new Map<
    string,
    { version?: string; error: string; timestamp: number }
  >();

  constructor(options: ActorRuntimeOptions = {}) {
    this._storage = options.storage ?? new InMemoryActorStorage();
    this.defaultNamespace = options.namespace;
    if (options.actors) {
      for (const actor of options.actors) {
        this.register(actor);
      }
    }
  }

  get storage(): ActorStorage {
    return this._storage;
  }

  get namespace(): string | undefined {
    return this.defaultNamespace;
  }

  /**
   * Explicitly registers actor classes with the runtime.
   * Supports unit test harnesses without requiring build-time discovery.
   * Handles multi-application workspaces and duplicate actor names cleanly.
   */
  register<T extends object>(
    actorClassOrClasses: Constructor<T> | Constructor<T>[],
    options?: ActorOptions,
  ): this {
    const list = Array.isArray(actorClassOrClasses) ? actorClassOrClasses : [actorClassOrClasses];

    for (const ctor of list) {
      const meta = getOrCreateActorMetadata(ctor);
      const name = options?.name ?? meta.name ?? ctor.name;
      const namespace = options?.namespace ?? meta.namespace ?? this.defaultNamespace;

      if (!meta.name) meta.name = name;
      if (options?.migrations) {
        meta.migrations = options.migrations;
      }

      const registration: ActorRegistration = {
        name,
        namespace,
        ctor,
        options,
      };

      const qualifiedName = namespace ? `${namespace}:${name}` : name;
      this.registryByQualifiedName.set(qualifiedName, registration);
      this.registryByCtor.set(ctor, registration);

      let group = this.actorsByNameGroup.get(name);
      if (!group) {
        group = [];
        this.actorsByNameGroup.set(name, group);
      }
      // Replace existing registration if same ctor or namespace
      const existingIdx = group.findIndex(
        (r) => r.ctor === ctor || (r.namespace === namespace && r.name === name),
      );
      if (existingIdx >= 0) {
        group[existingIdx] = registration;
      } else {
        group.push(registration);
      }

      if (group.length > 1) {
        this.registryByName.set(name, "ambiguous");
      } else {
        this.registryByName.set(name, registration);
      }
    }

    return this;
  }

  /**
   * Discovers decorated actor classes in the project and registers them automatically.
   */
  async discoverAndRegister(options: ActorDiscoveryOptions = {}): Promise<DiscoveredActor[]> {
    const discovered = await discoverActorClasses(options);
    for (const d of discovered) {
      this.register(d.ctor, {
        name: d.name,
        namespace: d.namespace ?? this.defaultNamespace,
      });
    }
    return discovered;
  }

  /**
   * Checks whether an actor class or name is registered.
   */
  isRegistered(actorClassOrName: Constructor | string): boolean {
    if (typeof actorClassOrName === "string") {
      if (actorClassOrName.includes(":")) {
        return this.registryByQualifiedName.has(actorClassOrName);
      }
      if (this.defaultNamespace) {
        const qualified = `${this.defaultNamespace}:${actorClassOrName}`;
        if (this.registryByQualifiedName.has(qualified)) return true;
      }
      return this.registryByName.has(actorClassOrName);
    }
    return this.registryByCtor.has(actorClassOrName);
  }

  /**
   * Returns all registered actor definitions.
   */
  getRegisteredActors(): ActorRegistration[] {
    return Array.from(this.registryByCtor.values());
  }

  /**
   * Returns a typed actor reference proxy for the given actor class and key.
   */
  get<T extends object>(actorClass: Constructor<T>, actorKey: string): ActorRef<T>;
  get<T = any>(actorName: string, actorKey: string): ActorRef<T>;
  get<T extends object>(actorClassOrName: Constructor<T> | string, actorKey: string): ActorRef<T> {
    const reg = this.resolveRegistration(actorClassOrName);
    if (!reg) {
      const name = typeof actorClassOrName === "string" ? actorClassOrName : actorClassOrName.name;
      throw new ActorNotRegisteredError(name);
    }
    const targetLookup = typeof actorClassOrName === 'function' ? actorClassOrName : (reg.namespace ? `${reg.namespace}:${reg.name}` : reg.name);
    return createActorReference<T>(targetLookup, actorKey, this, reg.name);
  }

  resolveRegistration(
    actorClassOrName: Constructor | string,
  ): ActorRegistration | undefined {
    if (typeof actorClassOrName === "function") {
      return this.registryByCtor.get(actorClassOrName);
    }

    if (actorClassOrName.includes(":")) {
      return this.registryByQualifiedName.get(actorClassOrName);
    }

    if (this.defaultNamespace) {
      const qualified = `${this.defaultNamespace}:${actorClassOrName}`;
      const found = this.registryByQualifiedName.get(qualified);
      if (found) return found;
    }

    const regOrAmbiguous = this.registryByName.get(actorClassOrName);
    if (regOrAmbiguous === "ambiguous") {
      const candidates = (this.actorsByNameGroup.get(actorClassOrName) ?? []).map(
        (r) => r.namespace || "default",
      );
      throw new ActorAmbiguityError(actorClassOrName, candidates);
    }

    return regOrAmbiguous;
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

    try {
      await runActorMigrations({
        actorType: reg.name,
        actorKey,
        compositeId,
        storage: this._storage,
        migrations,
      });

      this.migratedActors.add(compositeId);
      this.migrationFailures.delete(compositeId);
    } catch (err: any) {
      this.migrationFailures.set(compositeId, {
        version: err?.migrationVersion ?? err?.version,
        error: err?.message ?? String(err),
        timestamp: Date.now(),
      });
      throw err;
    }
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

      if (typeof instance.onActivate === "function") {
        await instance.onActivate();
      }

      this.instances.set(compositeId, instance);
    }
    return instance;
  }

  getCompositeId(reg: ActorRegistration, actorKey: string): string {
    const namespace = reg.options?.namespace ?? reg.namespace ?? this.defaultNamespace;
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
      const name = typeof actorClassOrName === "string" ? actorClassOrName : actorClassOrName.name;
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
          await this.ensureActorMigrated(reg, compositeId, actorKey);
          const tx = await this._storage.beginTransaction(compositeId);
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

    if (typeof instance.onDeactivate === "function") {
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

    if (typeof this._storage.closeActor === "function") {
      await this._storage.closeActor(compositeId);
    }

    return true;
  }

  /**
   * Hot reload:
   * - Stops admission to replaced activations.
   * - Drains or explicitly fails outstanding work according to runtime policy.
   * - Releases resources and replaces registrations without creating overlapping owners.
   * - Preserves committed state across reloads.
   * - Clears migration cache so pending actor migrations apply before resuming calls.
   */
  async reload(options: ActorReloadOptions = {}): Promise<ActorReloadResult> {
    const startTime = Date.now();
    const policy = options.policy ?? "drain";
    const timeoutMs = options.timeoutMs ?? 5000;
    const targetNs = options.namespace;

    // 1. Identify affected composite IDs
    const affectedIds = new Set<string>();
    for (const id of this.instances.keys()) {
      const parsed = parseActorIdentity(id);
      if (!targetNs || parsed.namespace === targetNs) {
        affectedIds.add(id);
      }
    }
    for (const id of this.mailboxes.keys()) {
      const parsed = parseActorIdentity(id);
      if (!targetNs || parsed.namespace === targetNs) {
        affectedIds.add(id);
      }
    }

    // 2. Stop admission to replaced activations immediately
    for (const id of affectedIds) {
      const mb = this.mailboxes.get(id);
      if (mb) {
        mb.stopAdmission();
      }
    }

    // 3. Drain or explicitly fail outstanding work according to policy
    for (const id of affectedIds) {
      const mb = this.mailboxes.get(id);
      if (mb) {
        if (policy === "fail") {
          mb.failPending(new ActorReloadError("Activation replaced during hot reload."));
          if (mb.runningCalls > 0) {
            try {
              await mb.drain(timeoutMs);
            } catch {}
          }
        } else {
          await mb.drain(timeoutMs);
        }
      }
    }

    // 4. Release resources and deactivate without creating overlapping owners
    let deactivatedCount = 0;
    for (const id of affectedIds) {
      const instance = this.instances.get(id);
      if (instance) {
        if (typeof instance.onDeactivate === "function") {
          try {
            await instance.onDeactivate();
          } catch {}
        }
        this.instances.delete(id);
        deactivatedCount++;
      }

      if (typeof this._storage.closeActor === "function") {
        await this._storage.closeActor(id);
      }

      const mb = this.mailboxes.get(id);
      if (mb) {
        mb.clear();
        this.mailboxes.delete(id);
      }
    }

    // 5. Replace registrations if new actor classes are provided
    const reloadedNames: string[] = [];
    if (options.actors && options.actors.length > 0) {
      for (const actorCtor of options.actors) {
        this.register(actorCtor, targetNs ? { namespace: targetNs } : undefined);
        reloadedNames.push(actorCtor.name);
      }
    } else {
      for (const reg of this.getRegisteredActors()) {
        if (!targetNs || reg.options?.namespace === targetNs) {
          reloadedNames.push(reg.name);
        }
      }
    }

    // 6. Clear migration cache so pending migrations are evaluated & applied before calls resume
    if (targetNs) {
      for (const id of Array.from(this.migratedActors)) {
        const parsed = parseActorIdentity(id);
        if (parsed.namespace === targetNs) {
          this.migratedActors.delete(id);
        }
      }
    } else {
      this.migratedActors.clear();
    }

    return {
      policy,
      reloadedActors: reloadedNames,
      deactivatedCount,
      durationMs: Date.now() - startTime,
      success: true,
    };
  }

  /**
   * Scoped development reset command.
   * Deactivates matching instances, closes locks, and explicitly removes persisted database files.
   * Startup and reload never delete state; reset is explicit and scoped.
   */
  async reset(options: ActorResetOptions = {}): Promise<ActorResetResult> {
    const { namespace, actorName, actorKey, all } = options;

    if (!all && !namespace && !actorName) {
      throw new Error(
        "Actor reset requires explicit scope: specify 'namespace', 'actorName', or 'all: true'.",
      );
    }

    const affectedIds: string[] = [];
    const allKnownIds = new Set([...this.instances.keys(), ...this.mailboxes.keys()]);

    for (const id of allKnownIds) {
      const parsed = parseActorIdentity(id);
      let matches = false;
      if (all) {
        matches = true;
      } else if (namespace && !actorName) {
        matches = parsed.namespace === namespace;
      } else if (actorName && !namespace) {
        matches = parsed.actorName === actorName && (!actorKey || parsed.actorKey === actorKey);
      } else if (namespace && actorName) {
        matches =
          parsed.namespace === namespace &&
          parsed.actorName === actorName &&
          (!actorKey || parsed.actorKey === actorKey);
      }

      if (matches) {
        affectedIds.push(id);
      }
    }

    let deactivatedCount = 0;
    for (const id of affectedIds) {
      const mb = this.mailboxes.get(id);
      if (mb) {
        mb.stopAdmission();
        mb.failPending(new Error("Actor instance reset."));
        mb.clear();
        this.mailboxes.delete(id);
      }

      const instance = this.instances.get(id);
      if (instance) {
        if (typeof instance.onDeactivate === "function") {
          try {
            await instance.onDeactivate();
          } catch {}
        }
        this.instances.delete(id);
        deactivatedCount++;
      }

      if (typeof this._storage.closeActor === "function") {
        await this._storage.closeActor(id);
      }

      this.migratedActors.delete(id);
      this.migrationFailures.delete(id);
    }

    // Remove persisted files if storage supports it
    const deletedFiles: string[] = [];
    if (typeof (this._storage as any).resetStorage === "function") {
      const deleted = await (this._storage as any).resetStorage({
        namespace,
        actorName,
        actorKey,
        all,
      });
      deletedFiles.push(...deleted);
    }

    return {
      scope: { namespace, actorName, actorKey, all },
      deletedFiles,
      deactivatedCount,
      success: true,
    };
  }

  /**
   * Diagnostic inspection of a specific actor identity.
   * Does NOT dump private state by default.
   */
  async inspect(
    actorClassOrName: Constructor | string,
    actorKey: string,
    options: { showState?: boolean; baseDir?: string } = {},
  ): Promise<ActorDetailedInspection | null> {
    let reg = this.resolveRegistration(actorClassOrName);
    let name = typeof actorClassOrName === "string" ? actorClassOrName : actorClassOrName.name;
    let namespace = this.defaultNamespace;

    if (typeof actorClassOrName === "string" && actorClassOrName.includes(":")) {
      const parsed = parseActorIdentity(actorClassOrName + (actorKey ? `:${actorKey}` : ""));
      namespace = parsed.namespace ?? namespace;
      name = parsed.actorName;
      if (!actorKey && parsed.actorKey) {
        actorKey = parsed.actorKey;
      }
    }

    if (!reg) {
      reg = this.resolveRegistration(name);
    }

    const meta = reg ? getOrCreateActorMetadata(reg.ctor) : undefined;
    namespace = reg?.options?.namespace ?? meta?.namespace ?? namespace;
    const compositeId = namespace ? `${namespace}:${name}:${actorKey}` : `${name}:${actorKey}`;

    const isActive = this.instances.has(compositeId);
    const mb = this.mailboxes.get(compositeId);
    const runningCalls = mb?.runningCalls ?? 0;
    const pendingCalls = mb?.pendingCalls ?? 0;

    let storagePath: string | undefined;
    if (this._storage instanceof SqliteActorStorage) {
      storagePath = actorIdentityToPath(compositeId, {
        baseDir: options.baseDir ?? this._storage.baseDir,
        inMemory: this._storage.inMemory,
      });
    }

    const failed = this.migrationFailures.get(compositeId);
    const methods = meta ? Array.from(meta.methods.keys()).map(String) : [];

    let state: Record<string, any> | undefined;
    if (options.showState && typeof (this._storage as any).dump === "function") {
      try {
        state = await (this._storage as any).dump(compositeId);
      } catch {}
    }

    return {
      actorId: compositeId,
      namespace,
      actorType: name,
      actorKey,
      status: isActive ? "active" : "inactive",
      runningCalls,
      pendingCalls,
      storagePath,
      methods,
      activeInstance: isActive,
      migrationStatus: {
        failedMigration: failed,
      },
      state,
    };
  }

  /**
   * Lists known actor identities, activation status, and pending/running calls.
   */
  async listActors(options: {
    namespace?: string;
    activeOnly?: boolean;
    baseDir?: string;
  } = {}): Promise<ActorInspectionInfo[]> {
    const list: ActorInspectionInfo[] = [];
    const seenIds = new Set<string>();

    // 1. Check in-memory instances and mailboxes
    const allRuntimeIds = new Set([...this.instances.keys(), ...this.mailboxes.keys()]);
    for (const compositeId of allRuntimeIds) {
      const parsed = parseActorIdentity(compositeId);
      if (options.namespace && parsed.namespace !== options.namespace) {
        continue;
      }

      seenIds.add(compositeId);
      const mb = this.mailboxes.get(compositeId);
      const isActive = this.instances.has(compositeId);

      let storagePath: string | undefined;
      if (this._storage instanceof SqliteActorStorage) {
        storagePath = actorIdentityToPath(compositeId, {
          baseDir: options.baseDir ?? this._storage.baseDir,
          inMemory: this._storage.inMemory,
        });
      }

      list.push({
        actorId: compositeId,
        namespace: parsed.namespace,
        actorType: parsed.actorName,
        actorKey: parsed.actorKey,
        status: isActive ? "active" : "inactive",
        runningCalls: mb?.runningCalls ?? 0,
        pendingCalls: mb?.pendingCalls ?? 0,
        storagePath,
        migrationStatus: {
          failedMigration: this.migrationFailures.get(compositeId),
        },
      });
    }

    // 2. Discover persisted actors on disk if using SQLite and !activeOnly
    if (!options.activeOnly && typeof (this._storage as any).listPersistedActors === "function") {
      try {
        const persisted = await (this._storage as any).listPersistedActors();
        for (const p of persisted) {
          if (options.namespace && p.namespace !== options.namespace) continue;
          // Extract actorKey from filename prefix if possible
          const fileName = p.filePath.split("/").pop() ?? "";
          const keyPrefix = fileName.replace(/_[0-9a-f]{16}\.db$/, "");
          const actorId = `${p.namespace}:${p.actorName}:${keyPrefix}`;

          if (!seenIds.has(actorId)) {
            seenIds.add(actorId);
            list.push({
              actorId,
              namespace: p.namespace,
              actorType: p.actorName,
              actorKey: keyPrefix,
              status: "inactive",
              runningCalls: 0,
              pendingCalls: 0,
              storagePath: p.filePath,
            });
          }
        }
      } catch {}
    }

    return list;
  }

  /**
   * Clears all active instances, mailboxes, and storage.
   */
  async clear(): Promise<void> {
    this.migratedActors.clear();
    this.migrationFailures.clear();
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
    if (typeof this._storage.close === "function") {
      await this._storage.close();
    } else if (typeof (this._storage as any).clearAll === "function") {
      await (this._storage as any).clearAll();
    }
  }
}

/**
 * Global default ActorRuntime instance.
 */
export const actors = new ActorRuntime();
