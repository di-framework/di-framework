import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  createMigrationDatabase,
  discoverManifestMigrations,
  MigrationRunner as MigrationRunnerType,
} from '@di-framework/repo';
import { CommandFailure } from '../../command';

export type MigrationRepoOperations = {
  readonly MigrationRunner: typeof MigrationRunnerType;
  readonly createMigrationDatabase: typeof createMigrationDatabase;
  readonly discoverManifestMigrations: typeof discoverManifestMigrations;
};

export interface MigrationCliParsedOptions {
  db?: string;
  dir?: string;
  manifest?: string;
  binding?: string;
  modules: string[];
  step?: number;
  dryRun?: boolean;
}

export function parseMigrationCliArgs(args: readonly string[]): MigrationCliParsedOptions {
  const options: MigrationCliParsedOptions = {
    modules: [],
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';

    if (token === '--db') {
      options.db = readNextValue(args, ++i, token);
      continue;
    }
    if (token === '--dir') {
      options.dir = readNextValue(args, ++i, token);
      continue;
    }
    if (token === '--manifest') {
      options.manifest = readNextValue(args, ++i, token);
      continue;
    }
    if (token === '--binding') {
      options.binding = readNextValue(args, ++i, token);
      continue;
    }
    if (token === '--module') {
      options.modules.push(readNextValue(args, ++i, token));
      continue;
    }
    if (token === '--step') {
      const val = readNextValue(args, ++i, token);
      const parsed = Number.parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new CommandFailure('INVALID_USAGE', `--step must be a positive integer: ${val}`, 2, {
          token,
          value: val,
        });
      }
      options.step = parsed;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    throw new CommandFailure('INVALID_USAGE', `Unknown migration option or argument: ${token}`, 2, {
      token,
    });
  }

  return options;
}

function readNextValue(args: readonly string[], index: number, option: string): string {
  const val = args[index];
  if (val === undefined || val.startsWith('--')) {
    throw new CommandFailure('INVALID_USAGE', `Missing value for ${option}`, 2, { option });
  }
  return val;
}

export async function loadMigrationRepoOperations(
  cwd: string,
  importModule: (specifier: string) => Promise<MigrationRepoOperations> = (specifier) =>
    import(specifier),
): Promise<MigrationRepoOperations> {
  // 1. Direct package import
  try {
    return await importModule('@di-framework/repo');
  } catch {}

  // 2. Project require resolve
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/repo');
    return await importModule(pathToFileURL(modulePath).href);
  } catch {}

  // 3. Monorepo relative fallback
  try {
    const monorepoSource = resolve(
      import.meta.dir,
      '../../../../packages/di-framework-repo/src/index.ts',
    );
    if (existsSync(monorepoSource)) {
      return await importModule(pathToFileURL(monorepoSource).href);
    }
  } catch {}

  throw new CommandFailure(
    'REPO_PACKAGE_UNAVAILABLE',
    'Unable to load @di-framework/repo from the current project',
    3,
  );
}

export async function createCliMigrationRunner(
  options: MigrationCliParsedOptions,
  cwd: string = process.cwd(),
  operations?: MigrationRepoOperations,
): Promise<MigrationRunnerType> {
  const binding = options.binding ?? 'default';
  const repo = operations ?? (await loadMigrationRepoOperations(cwd));

  // 1. Import modules containing @Migration decorated classes if provided
  for (const modPath of options.modules) {
    const fullPath = resolve(cwd, modPath);
    try {
      await import(pathToFileURL(fullPath).href);
    } catch (err) {
      throw new CommandFailure(
        'MODULE_LOAD_ERROR',
        `Failed to import migration module at ${modPath}: ${err instanceof Error ? err.message : String(err)}`,
        2,
        { path: modPath, cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  // 2. Discover manifest / SQL migrations
  let manifestPath = options.manifest;
  let dirPath = options.dir;

  if (!manifestPath && !dirPath) {
    if (existsSync(resolve(cwd, 'migrations.json'))) {
      manifestPath = 'migrations.json';
    } else if (existsSync(resolve(cwd, 'migrations'))) {
      dirPath = 'migrations';
    }
  }

  const discoveryOptions = { manifestPath, directory: dirPath, cwd };
  const discovered = await repo.discoverManifestMigrations({ ...discoveryOptions, binding });
  if (discovered.length === 0) {
    const unfiltered = await repo.discoverManifestMigrations(discoveryOptions);
    const availableBindings = [...new Set(unfiltered.map((m) => m.binding))];
    if (availableBindings.length > 0) {
      throw new CommandFailure(
        'MIGRATION_BINDING_MISMATCH',
        `No migrations found for binding '${binding}'. Available bindings: ${availableBindings.join(', ')}. Select one with --binding.`,
        2,
      );
    }
  }

  // 3. Resolve database connection
  const dbPath =
    options.db ?? process.env.DATABASE_URL ?? process.env.DB_PATH ?? resolve(cwd, 'dev.db');
  let db: any;
  try {
    db = await repo.createMigrationDatabase(dbPath);
  } catch (err) {
    throw new CommandFailure(
      'DB_CONNECTION_ERROR',
      `Failed to connect to database at '${dbPath}': ${err instanceof Error ? err.message : String(err)}`,
      1,
      { dbPath, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  return new repo.MigrationRunner({
    db,
    binding,
    migrations: discovered,
  });
}
