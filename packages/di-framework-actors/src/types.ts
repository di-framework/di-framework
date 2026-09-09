/**
 * Core type definitions for @di-framework/actors.
 */
import type { ActorMigrationDefinition } from './migrations/types.js';

export type Constructor<T = any> = new (...args: any[]) => T;

export interface ActorOptions {
  /**
   * Optional custom name for the actor type.
   * Defaults to the class name.
   */
  name?: string;

  /**
   * Optional namespace for partitioning actor storage and identities.
   * Defaults to 'default'.
   */
  namespace?: string;

  /**
   * Optional description or metadata for the actor.
   */
  description?: string;

  /**
   * Optional actor schema migrations applied before activating an actor instance.
   */
  migrations?: ActorMigrationDefinition[];
}

export interface ActorMethodOptions {
  /**
   * Optional custom name for the actor method.
   * Defaults to the method name.
   */
  name?: string;

  /**
   * Optional timeout in milliseconds for this method invocation.
   */
  timeout?: number;
}

export interface ActorMethodMetadata {
  name: string;
  methodName: string | symbol;
  options?: ActorMethodOptions;
  parameterContextIndices?: number[];
}

export interface ActorMetadata {
  name: string;
  namespace?: string;
  target: Constructor;
  methods: Map<string | symbol, ActorMethodMetadata>;
  contextProperties: Set<string | symbol>;
  contextParams: Map<string | symbol, number[]>;
  constructorContextIndex?: number;
  migrations?: ActorMigrationDefinition[];
}

/**
 * Optional lifecycle hooks for actor instances.
 */
export interface ActorLifecycle {
  /**
   * Invoked when an actor instance is created and activated in memory.
   */
  onActivate?(): void | Promise<void>;

  /**
   * Invoked when an actor instance is deactivated or passivated.
   */
  onDeactivate?(): void | Promise<void>;
}

/**
 * Strongly-typed reference to an actor instance.
 * All method invocations return a Promise representing the asynchronous
 * execution of the actor method through its serialized mailbox.
 */
export type ActorRef<T> = {
  /**
   * The unique key/identifier of this actor instance.
   */
  readonly actorKey: string;

  /**
   * The actor type / class name.
   */
  readonly actorType: string;

  /**
   * Composite identifier in format `${actorType}:${actorKey}`.
   */
  readonly id: string;
} & {
  [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: T[K] extends (
    ...args: infer Args
  ) => infer Return
    ? (...args: Args) => Promise<Awaited<Return>>
    : never;
};

/**
 * Thrown when an actor is requested or invoked but has not been registered.
 */
export class ActorNotRegisteredError extends Error {
  readonly actorType: string;

  constructor(actorType: string) {
    super(`Actor '${actorType}' is not registered with the actor runtime.`);
    this.name = 'ActorNotRegisteredError';
    this.actorType = actorType;
  }
}

/**
 * Thrown when an invoked method does not exist or is not exposed on the actor.
 */
export class ActorMethodNotFoundError extends Error {
  readonly actorType: string;
  readonly methodName: string;

  constructor(actorType: string, methodName: string) {
    super(`Method '${methodName}' not found on actor '${actorType}'.`);
    this.name = 'ActorMethodNotFoundError';
    this.actorType = actorType;
    this.methodName = methodName;
  }
}

/**
 * Thrown when an actor name is ambiguous across multiple namespaces.
 */
export class ActorAmbiguityError extends Error {
  readonly actorName: string;
  readonly candidates: string[];

  constructor(actorName: string, candidates: string[]) {
    super(
      `Multiple actors registered with name '${actorName}' across namespaces: ${candidates.join(', ')}. Disambiguate by actor class or qualified name ('namespace:actorName').`,
    );
    this.name = 'ActorAmbiguityError';
    this.actorName = actorName;
    this.candidates = candidates;
  }
}

/**
 * Thrown when an invocation is attempted on an activation whose admission has been closed.
 */
export class ActorAdmissionClosedError extends Error {
  constructor(
    message = 'Actor activation is closed to new admissions (reloading or deactivated).',
  ) {
    super(message);
    this.name = 'ActorAdmissionClosedError';
  }
}

/**
 * Thrown when an invocation is aborted or rejected due to hot reload.
 */
export class ActorReloadError extends Error {
  constructor(message = 'Activation replaced or canceled during hot reload.') {
    super(message);
    this.name = 'ActorReloadError';
  }
}

export type ReloadPolicy = 'drain' | 'fail';

export interface ActorReloadOptions {
  /**
   * Outstanding work policy during reload:
   * "drain" waits for pending invocations to complete (default).
   * "fail" explicitly aborts/rejects pending unstarted invocations.
   */
  policy?: ReloadPolicy;

  /**
   * Timeout in milliseconds when draining work before forcing release (default 5000ms).
   */
  timeoutMs?: number;

  /**
   * New actor classes to register. If provided, replaces existing registered classes.
   */
  actors?: Constructor[];

  /**
   * Optional namespace filter for scoped reload.
   */
  namespace?: string;
}

export interface ActorReloadResult {
  policy: ReloadPolicy;
  reloadedActors: string[];
  deactivatedCount: number;
  durationMs: number;
  success: boolean;
}

export interface ActorResetOptions {
  /**
   * Scope reset to a specific application namespace.
   */
  namespace?: string;

  /**
   * Scope reset to a specific actor type.
   */
  actorName?: string;

  /**
   * Scope reset to a specific actor key. Requires actorName.
   */
  actorKey?: string;

  /**
   * Explicitly reset all actors across all namespaces.
   */
  all?: boolean;

  /**
   * Base directory for actor storage.
   */
  baseDir?: string;
}

export interface ActorResetResult {
  scope: {
    namespace?: string;
    actorName?: string;
    actorKey?: string;
    all?: boolean;
  };
  deletedFiles: string[];
  deactivatedCount: number;
  success: boolean;
}

export interface ActorInspectionInfo {
  /** True for legacy files whose original actor identity is unavailable. */
  identityInferred?: boolean;
  actorId: string;
  namespace?: string;
  actorType: string;
  actorKey: string;
  status: 'active' | 'inactive';
  runningCalls: number;
  pendingCalls: number;
  storagePath?: string;
  migrationStatus?: {
    appliedCount?: number;
    pendingCount?: number;
    failedMigration?: {
      version?: string;
      error: string;
      timestamp?: number;
    };
  };
}

export interface ActorDetailedInspection extends ActorInspectionInfo {
  methods: string[];
  activeInstance: boolean;
  lastActive?: number;
  state?: Record<string, any>;
}

export { ActorMigrationError } from './migrations/types.js';
export { ActorLockError } from './storage/lock.js';
