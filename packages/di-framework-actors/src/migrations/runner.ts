/**
 * Actor migration runner.
 * Reuses MigrationRunner from @di-framework/repo to execute pending migrations
 * within each actor's SQLite database with locking, checksum validation, and order integrity.
 */
import { createHash } from 'node:crypto';
import {
  compareVersions,
  getRegisteredMigrations,
  type MigrationDefinition,
  type MigrationExecutionContext,
  MigrationExecutionError,
  MigrationRunner,
} from '@di-framework/repo';
import type { ActorStorage } from '../storage/types.js';
import { getRegisteredActorMigrations } from './decorator.js';
import {
  type ActorMigrationContext,
  type ActorMigrationDefinition,
  ActorMigrationError,
} from './types.js';

export interface RunActorMigrationsOptions {
  actorType: string;
  actorKey: string;
  compositeId: string;
  storage: ActorStorage;
  migrations?: ActorMigrationDefinition[];
}

let inMemoryHistory = new WeakMap<ActorStorage, Map<string, Set<string>>>();

export async function runActorMigrations(options: RunActorMigrationsOptions): Promise<void> {
  const { actorType, actorKey, compositeId, storage } = options;

  // 1. Gather all candidate migrations for this actor
  const migrationMap = new Map<string, ActorMigrationDefinition>();

  // A. Options / class-configured migrations
  if (options.migrations) {
    for (const m of options.migrations) {
      migrationMap.set(String(m.version), m);
    }
  }

  // B. @ActorMigration registered migrations
  for (const m of getRegisteredActorMigrations(actorType)) {
    if (!migrationMap.has(String(m.version))) {
      migrationMap.set(String(m.version), m);
    }
  }

  // C. @di-framework/repo @Migration registered classes with matching binding
  try {
    for (const m of getRegisteredMigrations()) {
      if (m.binding === actorType && !migrationMap.has(m.version)) {
        migrationMap.set(m.version, {
          version: m.version,
          description: m.description,
          checksum: m.checksum,
          up: async (ctx) => {
            const execCtx: MigrationExecutionContext = {
              binding: actorType,
              version: ctx.version,
              description: ctx.description,
              db: ctx.db,
              sql: ctx.sql,
              run: ctx.run,
            };
            await m.up(execCtx);
          },
        });
      }
    }
  } catch {
    // If @di-framework/repo decorator registry is empty or not initialized
  }

  if (migrationMap.size === 0) {
    return;
  }

  const allMigrations = Array.from(migrationMap.values());

  // 2. Check if storage supports native database handle (e.g. SqliteActorStorage)
  if (typeof storage.getDatabase === 'function') {
    const db = await storage.getDatabase(compositeId);

    const preparedDefinitions: MigrationDefinition[] = allMigrations.map((m) => {
      const ver = String(m.version);
      const checksum = m.checksum ?? createHash('sha256').update(m.up.toString()).digest('hex');

      return {
        version: ver,
        description: m.description,
        binding: actorType,
        checksum,
        up: async (execCtx: MigrationExecutionContext) => {
          const actorCtx: ActorMigrationContext = {
            actorId: compositeId,
            actorType,
            actorKey,
            version: execCtx.version,
            description: execCtx.description,
            db: execCtx.db,
            sql: execCtx.sql,
            run: execCtx.run,
            storage,
          };
          await m.up(actorCtx);
        },
        down: m.down
          ? async (execCtx: MigrationExecutionContext) => {
              const actorCtx: ActorMigrationContext = {
                actorId: compositeId,
                actorType,
                actorKey,
                version: execCtx.version,
                description: execCtx.description,
                db: execCtx.db,
                sql: execCtx.sql,
                run: execCtx.run,
                storage,
              };
              await m.down!(actorCtx);
            }
          : undefined,
      };
    });

    const runner = new MigrationRunner({
      db,
      binding: actorType,
      migrations: preparedDefinitions,
    });

    try {
      await runner.execute({ binding: actorType });
    } catch (err: any) {
      let failedVersion: string | undefined;
      if (err instanceof MigrationExecutionError) {
        failedVersion = err.version;
      } else if (err?.version) {
        failedVersion = String(err.version);
      }

      throw new ActorMigrationError({
        actorType,
        actorKey,
        migrationVersion: failedVersion,
        message: err instanceof Error ? err.message : String(err),
        cause: err?.cause ?? err,
      });
    }
  } else {
    // 3. Fallback for non-SQL storage (e.g. pure InMemoryActorStorage)
    let storageHistory = inMemoryHistory.get(storage);
    if (!storageHistory) {
      storageHistory = new Map();
      inMemoryHistory.set(storage, storageHistory);
    }
    let applied = storageHistory.get(compositeId);
    if (!applied) {
      applied = new Set<string>();
      storageHistory.set(compositeId, applied);
    }

    const sorted = [...allMigrations].sort((a, b) =>
      compareVersions(String(a.version), String(b.version)),
    );

    for (const m of sorted) {
      const ver = String(m.version);
      if (applied.has(ver)) continue;

      const actorCtx: ActorMigrationContext = {
        actorId: compositeId,
        actorType,
        actorKey,
        version: ver,
        description: m.description,
        db: null,
        sql: async () => [],
        run: async () => ({ changes: 0 }),
        storage,
      };

      try {
        await m.up(actorCtx);
        applied.add(ver);
      } catch (err: any) {
        throw new ActorMigrationError({
          actorType,
          actorKey,
          migrationVersion: ver,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        });
      }
    }
  }
}

export function clearInMemoryActorMigrationHistory(): void {
  inMemoryHistory = new WeakMap();
}
