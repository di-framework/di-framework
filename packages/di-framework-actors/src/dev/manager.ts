/**
 * ActorDevManager provides local development management, inspection,
 * discovery, hot reload, and reset capabilities for virtual actors.
 */
import { ActorRuntime } from '../runtime/runtime';
import { SqliteActorStorage } from '../storage/sqlite';
import type {
  ActorDetailedInspection,
  ActorInspectionInfo,
  ActorReloadOptions,
  ActorReloadResult,
  ActorResetOptions,
  ActorResetResult,
  Constructor,
} from '../types';
import {
  type ActorDiscoveryOptions,
  type DiscoveredActor,
  discoverActorClasses,
} from './discovery';

export interface ActorDevManagerOptions {
  runtime?: ActorRuntime;
  namespace?: string;
  baseDir?: string;
  cwd?: string;
}

export class ActorDevManager {
  readonly runtime: ActorRuntime;
  readonly baseDir: string;
  readonly namespace?: string;
  readonly cwd: string;

  constructor(options: ActorDevManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseDir = options.baseDir ?? '.actors';
    this.namespace = options.namespace;

    if (options.runtime) {
      this.runtime = options.runtime;
    } else {
      const storage = new SqliteActorStorage({
        baseDir: this.baseDir,
      });
      this.runtime = new ActorRuntime({
        storage,
        namespace: this.namespace,
      });
    }
  }

  /**
   * Discovers decorated actor classes in the project and registers them with the runtime.
   */
  async discoverAndRegister(options: ActorDiscoveryOptions = {}): Promise<DiscoveredActor[]> {
    const discovered = await discoverActorClasses({
      cwd: this.cwd,
      ...options,
    });

    for (const d of discovered) {
      this.runtime.register(d.ctor, {
        name: d.name,
        namespace: d.namespace ?? this.namespace,
      });
    }

    return discovered;
  }

  /**
   * Lists known actor identities, activation status, and call counts.
   */
  async list(
    options: { namespace?: string; activeOnly?: boolean; baseDir?: string } = {},
  ): Promise<ActorInspectionInfo[]> {
    return this.runtime.listActors({
      namespace: options.namespace ?? this.namespace,
      activeOnly: options.activeOnly,
      baseDir: options.baseDir ?? this.baseDir,
    });
  }

  /**
   * Inspects a specific actor identity, activation status, and migration state without dumping private state by default.
   */
  async inspect(
    identityOrName: string,
    key?: string,
    options: { showState?: boolean } = {},
  ): Promise<ActorDetailedInspection | null> {
    return this.runtime.inspect(identityOrName, key ?? '', options);
  }

  /**
   * Triggers a hot reload on the runtime: stops admission, drains or fails work,
   * releases resources, and replaces registrations while preserving committed state.
   */
  async reload(options: ActorReloadOptions = {}): Promise<ActorReloadResult> {
    return this.runtime.reload(options);
  }

  /**
   * Explicit scoped development reset command.
   */
  async reset(options: ActorResetOptions = {}): Promise<ActorResetResult> {
    return this.runtime.reset({
      baseDir: this.baseDir,
      namespace: this.namespace,
      ...options,
    });
  }

  async close(): Promise<void> {
    await this.runtime.clear();
  }
}
