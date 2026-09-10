import { createMigrationDatabase } from './database';
import { getRegisteredMigrations } from './decorator';
import { compareVersions, sortMigrations } from './discovery';
import type {
  AutoApplyOptions,
  ExecuteOptions,
  MigrationDatabase,
  MigrationDefinition,
  MigrationExecutionContext,
  MigrationExecutionResult,
  MigrationLock,
  MigrationRecord,
  MigrationRunnerOptions,
  MigrationStatus,
  StatusOptions,
} from './types';
import {
  MigrationError,
  MigrationExecutionError,
  MigrationIntegrityError,
  MigrationLockError,
  MigrationOrderError,
} from './types';

export class MigrationRunner {
  private dbPromise: Promise<MigrationDatabase> | null = null;
  private readonly defaultBinding: string;
  private readonly migrationsTable: string;
  private readonly lockTable: string;
  private readonly lockTimeoutMs: number;
  private readonly configuredMigrations: MigrationDefinition[];
  private readonly runnerId: string;

  constructor(private readonly options: MigrationRunnerOptions) {
    this.defaultBinding = options.binding ?? 'default';
    this.migrationsTable = options.migrationsTable ?? '_migrations';
    this.lockTable = options.lockTable ?? '_migrations_lock';
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60000;
    this.configuredMigrations = options.migrations ? [...options.migrations] : [];
    this.runnerId = `runner_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async getDb(): Promise<MigrationDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = createMigrationDatabase(this.options.db);
    }
    return this.dbPromise;
  }

  async initTables(): Promise<void> {
    const db = await this.getDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.migrationsTable}" (
        "version" VARCHAR(255) PRIMARY KEY,
        "description" TEXT NOT NULL,
        "binding" VARCHAR(255) NOT NULL,
        "applied_at" TEXT NOT NULL,
        "checksum" TEXT NOT NULL,
        "execution_time_ms" INTEGER NOT NULL
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.lockTable}" (
        "id" VARCHAR(64) PRIMARY KEY,
        "locked" INTEGER NOT NULL,
        "acquired_at" TEXT,
        "locked_by" TEXT
      );
    `);
  }

  async acquireLock(binding: string = this.defaultBinding): Promise<void> {
    const db = await this.getDb();
    const lockId = `migration_lock_${binding}`;
    const now = new Date().toISOString();

    await db.transaction(async (txDb) => {
      const existing = await txDb.first<MigrationLock>(
        `SELECT id, locked, acquired_at, locked_by FROM "${this.lockTable}" WHERE id = ?`,
        [lockId],
      );

      if (!existing) {
        await txDb.run(
          `INSERT INTO "${this.lockTable}" (id, locked, acquired_at, locked_by) VALUES (?, 1, ?, ?)`,
          [lockId, now, this.runnerId],
        );
        return;
      }

      if (existing.locked === 1) {
        const acquiredTime = existing.acquired_at ? new Date(existing.acquired_at).getTime() : 0;
        const elapsed = Date.now() - acquiredTime;
        if (elapsed > this.lockTimeoutMs) {
          // Lock timed out; steal lock
          await txDb.run(
            `UPDATE "${this.lockTable}" SET locked = 1, acquired_at = ?, locked_by = ? WHERE id = ?`,
            [now, this.runnerId, lockId],
          );
          return;
        }
        throw new MigrationLockError(
          `Migration lock for binding '${binding}' is currently held by '${existing.locked_by}' since ${existing.acquired_at}`,
          existing,
        );
      }

      await txDb.run(
        `UPDATE "${this.lockTable}" SET locked = 1, acquired_at = ?, locked_by = ? WHERE id = ?`,
        [now, this.runnerId, lockId],
      );
    });
  }

  async releaseLock(binding: string = this.defaultBinding): Promise<void> {
    const db = await this.getDb();
    const lockId = `migration_lock_${binding}`;
    await db.run(
      `UPDATE "${this.lockTable}" SET locked = 0, acquired_at = NULL, locked_by = NULL WHERE id = ? AND locked_by = ?`,
      [lockId, this.runnerId],
    );
  }

  async withLock<T>(binding: string, fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(binding);
    try {
      return await fn();
    } finally {
      try {
        await this.releaseLock(binding);
      } catch {
        // Suppress release lock errors if original fn threw
      }
    }
  }

  async getHistory(binding: string = this.defaultBinding): Promise<MigrationRecord[]> {
    const db = await this.getDb();
    const rows = await db.query<MigrationRecord>(
      `SELECT version, description, binding, applied_at, checksum, execution_time_ms FROM "${this.migrationsTable}" WHERE binding = ?`,
      [binding],
    );
    return rows.sort((a, b) => compareVersions(a.version, b.version));
  }

  /**
   * Resolves all migrations: configured + registered decorator classes.
   */
  resolveMigrations(binding: string = this.defaultBinding): MigrationDefinition[] {
    const combined = new Map<string, MigrationDefinition>();

    // 1. Configured migrations (e.g. from manifest or sql files)
    for (const m of this.configuredMigrations) {
      if (m.binding === binding) {
        combined.set(m.version, m);
      }
    }

    // 2. Registered decorator classes
    for (const m of getRegisteredMigrations()) {
      if (m.binding === binding) {
        // If not already explicitly configured with same version
        if (!combined.has(m.version)) {
          combined.set(m.version, m);
        }
      }
    }

    return sortMigrations(Array.from(combined.values()));
  }

  validateIntegrity(discovered: MigrationDefinition[], applied: MigrationRecord[]): void {
    // 1. Check for duplicate versions in discovered
    const seen = new Set<string>();
    for (const m of discovered) {
      if (seen.has(m.version)) {
        throw new MigrationIntegrityError(`Duplicate migration version detected: ${m.version}`);
      }
      seen.add(m.version);
    }

    // 2. Verify applied checksums against discovered
    for (const app of applied) {
      const disc = discovered.find((d) => d.version === app.version && d.binding === app.binding);
      if (!disc) {
        throw new MigrationIntegrityError(
          `Applied migration ${app.version} ('${app.description}') was not found in discovered migrations.`,
          app.version,
        );
      }
      if (disc.checksum !== app.checksum) {
        throw new MigrationIntegrityError(
          `Checksum mismatch for migration ${app.version} ('${app.description}'). Expected ${app.checksum}, found ${disc.checksum}. Migration content has been altered after application.`,
          app.version,
          app.checksum,
          disc.checksum,
        );
      }
    }

    // 3. Check for out-of-order pending migrations
    if (applied.length > 0) {
      const latestApplied = applied[applied.length - 1]!;
      const appliedVersionSet = new Set(applied.map((a) => a.version));
      for (const disc of discovered) {
        if (!appliedVersionSet.has(disc.version)) {
          if (compareVersions(disc.version, latestApplied.version) < 0) {
            throw new MigrationOrderError(
              `Pending migration ${disc.version} ('${disc.description}') has a lower version than already applied migration ${latestApplied.version} ('${latestApplied.description}'). Out-of-order migrations are not allowed.`,
              disc.version,
              latestApplied.version,
            );
          }
        }
      }
    }
  }

  async status(options: StatusOptions = {}): Promise<MigrationStatus> {
    await this.initTables();
    const binding = options.binding ?? this.defaultBinding;
    const applied = await this.getHistory(binding);
    const discovered = this.resolveMigrations(binding);

    this.validateIntegrity(discovered, applied);

    const appliedSet = new Set(applied.map((a) => a.version));
    const pending = discovered.filter((m) => !appliedSet.has(m.version));

    return {
      binding,
      applied,
      pending,
      isUpToDate: pending.length === 0,
    };
  }

  async execute(options: ExecuteOptions = {}): Promise<MigrationExecutionResult> {
    const binding = options.binding ?? this.defaultBinding;
    await this.initTables();

    return this.withLock(binding, async () => {
      const totalStart = performance.now();
      const applied = await this.getHistory(binding);
      const discovered = this.resolveMigrations(binding);

      this.validateIntegrity(discovered, applied);

      const appliedSet = new Set(applied.map((a) => a.version));
      let toApply = discovered.filter((m) => !appliedSet.has(m.version));

      if (options.dryRun) {
        return {
          binding,
          applied: [],
          pending: toApply,
          dryRun: true,
          durationMs: 0,
        };
      }

      if (typeof options.step === 'number' && options.step > 0) {
        toApply = toApply.slice(0, options.step);
      }

      const db = await this.getDb();
      const newlyApplied: MigrationRecord[] = [];

      for (const m of toApply) {
        const start = performance.now();
        const ctx: MigrationExecutionContext = {
          binding,
          version: m.version,
          description: m.description,
          db,
          sql: (q, p) => db.query(q, p),
          run: (q, p) => db.run(q, p),
        };

        try {
          await db.transaction(async (txDb) => {
            const txCtx: MigrationExecutionContext = {
              ...ctx,
              db: txDb,
              sql: (q, p) => txDb.query(q, p),
              run: (q, p) => txDb.run(q, p),
            };
            await m.up(txCtx);

            const durationMs = Math.round(performance.now() - start);
            const appliedAt = new Date().toISOString();

            await txDb.run(
              `INSERT INTO "${this.migrationsTable}" (version, description, binding, applied_at, checksum, execution_time_ms) VALUES (?, ?, ?, ?, ?, ?)`,
              [m.version, m.description, binding, appliedAt, m.checksum, durationMs],
            );

            newlyApplied.push({
              version: m.version,
              description: m.description,
              binding,
              applied_at: appliedAt,
              checksum: m.checksum,
              execution_time_ms: durationMs,
            });
          });
        } catch (error) {
          throw new MigrationExecutionError(
            `Failed to execute migration ${m.version} ('${m.description}'): ${error instanceof Error ? error.message : String(error)}`,
            m.version,
            error,
          );
        }
      }

      const totalDuration = Math.round(performance.now() - totalStart);
      const remainingPending = discovered.filter(
        (m) => !appliedSet.has(m.version) && !newlyApplied.some((a) => a.version === m.version),
      );

      return {
        binding,
        applied: newlyApplied,
        pending: remainingPending,
        dryRun: false,
        durationMs: totalDuration,
      };
    });
  }

  async autoApply(options: AutoApplyOptions = {}): Promise<MigrationExecutionResult> {
    const binding = options.binding ?? this.defaultBinding;
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const enabled = options.enabled ?? isDev;

    if (!enabled) {
      const curStatus = await this.status({ binding });
      if (options.throwIfPending && !curStatus.isUpToDate) {
        throw new MigrationError(
          `Pending database migrations exist for binding '${binding}', but autoApply is disabled in NODE_ENV='${process.env.NODE_ENV}'`,
        );
      }
      return {
        binding,
        applied: [],
        pending: curStatus.pending,
        dryRun: false,
        durationMs: 0,
      };
    }

    return this.execute({ binding });
  }

  async close(): Promise<void> {
    const db = await this.getDb();
    await db.close?.();
  }
}
