import { createHash } from 'node:crypto';
import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';
import type {
  MigrationClass,
  MigrationDefinition,
  MigrationExecutionContext,
  MigrationMetadata,
  MigrationOptions,
} from './types.js';

export const MIGRATION_METADATA_KEY = 'repo:migration';

const REGISTRY = new Set<MigrationClass>();

export function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Decorator to register a database migration.
 *
 * @example
 * ```ts
 * @Migration({
 *   version: 1,
 *   description: 'create users table',
 *   binding: 'default',
 * })
 * export class CreateUsersTable {
 *   async up(ctx: MigrationExecutionContext) {
 *     await ctx.sql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
 *   }
 * }
 * ```
 */
export function Migration(options: MigrationOptions) {
  if (options.version === undefined || options.version === null) {
    throw new Error('@Migration requires a valid version');
  }
  if (!options.description) {
    throw new Error('@Migration requires a description');
  }

  const normalizedMetadata: MigrationMetadata = {
    version: String(options.version),
    description: options.description,
    binding: options.binding ?? 'default',
  };

  return <T extends MigrationClass>(target: T): T => {
    normalizedMetadata.target = target;
    defineMetadata(MIGRATION_METADATA_KEY, normalizedMetadata, target);
    REGISTRY.add(target);
    return target;
  };
}

export function getMigrationMetadata(target: unknown): MigrationMetadata | undefined {
  if (!target || (typeof target !== 'function' && typeof target !== 'object')) {
    return undefined;
  }
  return getOwnMetadata(MIGRATION_METADATA_KEY, target) as MigrationMetadata | undefined;
}

export function isMigration(target: unknown): boolean {
  return getMigrationMetadata(target) !== undefined;
}

export function createMigrationFromClass(target: MigrationClass): MigrationDefinition {
  const meta = getMigrationMetadata(target);
  if (!meta) {
    throw new Error(`Class ${target.name} is not decorated with @Migration`);
  }

  // Compute checksum based on class code and metadata
  const classString = target.toString();
  const checksumPayload = `version:${meta.version};binding:${meta.binding};desc:${meta.description};source:${classString}`;
  const checksum = computeSha256(checksumPayload);

  let instanceCache: InstanceType<MigrationClass> | null = null;
  const getInstance = () => {
    if (!instanceCache) {
      instanceCache = new target();
    }
    return instanceCache;
  };

  return {
    version: meta.version,
    description: meta.description,
    binding: meta.binding,
    checksum,
    source: 'decorator',
    up: async (context: MigrationExecutionContext) => {
      const instance = getInstance();
      if (typeof instance.up === 'function') {
        await instance.up(context);
      } else if (typeof instance.execute === 'function') {
        await instance.execute(context);
      } else if (typeof instance.run === 'function') {
        await instance.run(context);
      } else {
        throw new Error(
          `Migration ${meta.version} (${target.name}) must implement an up(), execute(), or run() method`,
        );
      }
    },
    down: async (context: MigrationExecutionContext) => {
      const instance = getInstance();
      if (typeof instance.down === 'function') {
        await instance.down(context);
      }
    },
  };
}

export function getRegisteredMigrations(): MigrationDefinition[] {
  const definitions: MigrationDefinition[] = [];
  for (const cls of REGISTRY) {
    definitions.push(createMigrationFromClass(cls));
  }
  return definitions;
}

export function clearMigrationRegistry(): void {
  REGISTRY.clear();
}
