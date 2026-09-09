/**
 * Types and error definitions for actor migrations in @di-framework/actors.
 */
import type { MigrationDatabase } from '@di-framework/repo';
import type { ActorStorage } from '../storage/types.js';

export interface ActorMigrationContext {
  actorId: string;
  actorType: string;
  actorKey: string;
  version: string;
  description: string;
  db: MigrationDatabase | any;
  sql: (query: string, params?: unknown[]) => Promise<unknown[]>;
  run: (query: string, params?: unknown[]) => Promise<{ changes?: number }>;
  storage: ActorStorage;
}

export interface ActorMigrationDefinition {
  version: number | string;
  description: string;
  up: (context: ActorMigrationContext) => Promise<void> | void;
  down?: (context: ActorMigrationContext) => Promise<void> | void;
  checksum?: string;
}

export interface ActorMigrationOptions {
  actor?: any;
  version: number | string;
  description: string;
}

/**
 * Thrown when an actor migration fails, preventing actor activation.
 * Unambiguously identifies the affected actor and migration version.
 */
export class ActorMigrationError extends Error {
  readonly actorType: string;
  readonly actorKey: string;
  readonly migrationVersion?: string;
  readonly cause?: unknown;

  constructor(options: {
    actorType: string;
    actorKey: string;
    migrationVersion?: string;
    message: string;
    cause?: unknown;
  }) {
    const ver = options.migrationVersion ? ` [version ${options.migrationVersion}]` : '';
    super(
      `Failed migration${ver} for actor '${options.actorType}:${options.actorKey}': ${options.message}`,
    );
    this.name = 'ActorMigrationError';
    this.actorType = options.actorType;
    this.actorKey = options.actorKey;
    this.migrationVersion = options.migrationVersion;
    this.cause = options.cause;
  }
}
