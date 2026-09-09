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

export { ActorMigrationError } from './migrations/types.js';
export { ActorLockError } from './storage/lock.js';
export * from "./distributed/types.js";
export * from "./distributed/errors.js";
