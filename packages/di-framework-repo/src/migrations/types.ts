import type { SqlDatabase } from '../sqlite/sql-database';

export interface MigrationOptions {
  version: number | string;
  description: string;
  binding?: string;
}

export interface MigrationMetadata {
  version: string;
  description: string;
  binding: string;
  target?: unknown;
}

export interface MigrationClassInstance {
  up?(context: MigrationExecutionContext): Promise<void> | void;
  down?(context: MigrationExecutionContext): Promise<void> | void;
  execute?(context: MigrationExecutionContext): Promise<void> | void;
  run?(context: MigrationExecutionContext): Promise<void> | void;
}

export type MigrationClass = new (...args: any[]) => MigrationClassInstance;

/**
 * Database handle migrations execute against. Structurally identical to
 * `SqlDatabase`, so any Bun, Node, or Wasm-backed handle can run migrations.
 */
export type MigrationDatabase = SqlDatabase;

export interface MigrationExecutionContext {
  binding: string;
  version: string;
  description: string;
  db: MigrationDatabase;
  sql: (query: string, params?: unknown[]) => Promise<unknown[]>;
  run: (query: string, params?: unknown[]) => Promise<{ changes?: number }>;
}

export interface MigrationDefinition {
  version: string;
  description: string;
  binding: string;
  checksum: string;
  up: (context: MigrationExecutionContext) => Promise<void> | void;
  down?: (context: MigrationExecutionContext) => Promise<void> | void;
  source?: 'decorator' | 'sql' | 'manifest';
  filePath?: string;
}

export interface MigrationRecord {
  version: string;
  description: string;
  binding: string;
  applied_at: string;
  checksum: string;
  execution_time_ms: number;
}

export interface MigrationLock {
  id: string;
  locked: number;
  acquired_at: string | null;
  locked_by: string | null;
}

export interface MigrationStatus {
  binding: string;
  applied: MigrationRecord[];
  pending: MigrationDefinition[];
  isUpToDate: boolean;
}

export interface MigrationExecutionResult {
  binding: string;
  applied: MigrationRecord[];
  pending: MigrationDefinition[];
  dryRun: boolean;
  durationMs: number;
}

export interface ManifestMigrationEntry {
  version: number | string;
  description: string;
  binding?: string;
  file?: string;
  sql?: string;
  up?: string;
  down?: string;
}

export interface MigrationManifest {
  migrations: ManifestMigrationEntry[];
  binding?: string;
}

export interface ManifestDiscoveryOptions {
  manifestPath?: string;
  manifest?: MigrationManifest;
  directory?: string;
  binding?: string;
  cwd?: string;
}

export interface MigrationRunnerOptions {
  db: MigrationDatabase | unknown;
  binding?: string;
  migrationsTable?: string;
  lockTable?: string;
  lockTimeoutMs?: number;
  migrations?: MigrationDefinition[];
}

export interface StatusOptions {
  binding?: string;
}

export interface ExecuteOptions {
  binding?: string;
  step?: number;
  dryRun?: boolean;
}

export interface AutoApplyOptions {
  binding?: string;
  enabled?: boolean;
  throwIfPending?: boolean;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class MigrationLockError extends MigrationError {
  constructor(
    message: string,
    public readonly lockInfo?: Partial<MigrationLock>,
  ) {
    super(message);
    this.name = 'MigrationLockError';
  }
}

export class MigrationIntegrityError extends MigrationError {
  constructor(
    message: string,
    public readonly version?: string,
    public readonly expectedChecksum?: string,
    public readonly actualChecksum?: string,
  ) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

export class MigrationOrderError extends MigrationError {
  constructor(
    message: string,
    public readonly version?: string,
    public readonly latestAppliedVersion?: string,
  ) {
    super(message);
    this.name = 'MigrationOrderError';
  }
}

export class MigrationExecutionError extends MigrationError {
  constructor(
    message: string,
    public readonly version: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MigrationExecutionError';
  }
}
