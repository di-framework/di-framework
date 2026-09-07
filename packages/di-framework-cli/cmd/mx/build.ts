import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CliIo, CommandResult } from '../../command';
import { CommandFailure } from '../../command';

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

export function shellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return '';
}

export function buildFailure(pkgDir: string, err: unknown): CommandFailure {
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err ? shellText(err.stderr) : '';
  const stdout =
    typeof err === 'object' && err !== null && 'stdout' in err ? shellText(err.stdout) : '';
  const detail = (
    stderr.trim() ||
    stdout.trim() ||
    (err instanceof Error ? err.message : String(err))
  ).trim();
  return new CommandFailure('BUILD_FAILED', `Build failed for ${pkgDir}\n${detail}`, 1, {
    package: pkgDir,
    cause: detail,
  });
}

export type MxBuildOptions = {
  /** Copy the workspace root version into each package.json. Off by default so install/CI compile does not dirty trees. */
  syncVersions?: boolean;
  /** Workspace to build. Defaults to the current working directory. */
  workspaceRoot?: string;
};

export function parseMxBuildArgs(args: readonly string[] = process.argv.slice(2)): MxBuildOptions {
  for (const arg of args) {
    if (arg !== '--sync-versions') {
      throw new CommandFailure('INVALID_USAGE', `Unknown mx build argument: ${arg}`, 2, {
        argument: arg,
      });
    }
  }
  if (args.filter((arg) => arg === '--sync-versions').length > 1) {
    throw new CommandFailure('INVALID_USAGE', 'Duplicate mx build argument: --sync-versions', 2, {
      argument: '--sync-versions',
    });
  }
  return { syncVersions: args.includes('--sync-versions') };
}

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-config',
  'packages/di-framework-auth',
  'packages/di-framework-authz',
  'packages/di-framework-socket',
  'packages/di-framework-rpc',
  'packages/di-framework-ai',
  'packages/di-framework-ai-utils',
  'packages/di-framework-codegen',
  'packages/di-framework-cloudfoundry',
  'packages/di-framework-wasmcloud',
  'packages/di-framework-cli-extension',
  'packages/di-framework-cli-plugin-wasmcloud',
  'packages/di-framework-cli',
  // plugin.cjs + Go sidecar; package.json "build" is a no-op (not tsc/bun compile)
  'packages/di-framework-tsc',
];

export async function build(
  options: MxBuildOptions = {},
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  io.stdout.write('🚀 Starting build process...\n');

  const syncVersions = options.syncVersions === true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  let version: string | undefined;
  if (syncVersions) {
    const rootPkgPath = join(workspaceRoot, 'package.json');
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    version = rootPkg.version;
    io.stdout.write(`📌 Using version ${version} from workspace root\n`);
  }

  for (const pkgDir of PACKAGES) {
    io.stdout.write(`\n📦 Building ${pkgDir}...\n`);
    const fullPath = join(workspaceRoot, pkgDir);

    // Sync version only when requested (publish / release). Read-or-skip; no existsSync TOCTOU.
    if (syncVersions && version !== undefined) {
      const pkgJsonPath = join(fullPath, 'package.json');
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        writeFileSync(pkgJsonPath, JSON.stringify({ ...pkgJson, version }, null, 2) + '\n');
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err;
      }
    }

    // Clean dist and leftover incremental caches. `tsc` writes
    // `tsconfig.build.tsbuildinfo` next to the config when rootDir is `src`,
    // so deleting dist alone leaves a cache that skips emit on the next run.
    await $`rm -rf ${join(fullPath, 'dist')}`.quiet();
    await $`rm -f ${join(fullPath, 'tsconfig.build.tsbuildinfo')} ${join(fullPath, 'tsconfig.dist.tsbuildinfo')} ${join(fullPath, 'tsconfig.tsbuildinfo')}`.quiet();

    io.stdout.write('  Running build...\n');
    try {
      if (existsSync(join(fullPath, 'tsconfig.build.json'))) {
        await $`cd ${fullPath} && bun x tsc -p tsconfig.build.json --incremental false`.quiet();
      } else {
        await $`cd ${fullPath} && bun run build`.quiet();
      }
    } catch (err) {
      throw buildFailure(pkgDir, err);
    }

    io.stdout.write(`  ✅ Finished building ${pkgDir}\n`);
  }

  io.stdout.write('\n✨ All builds completed successfully!\n');
}

export async function runMxBuild(args: readonly string[], io: CliIo): Promise<CommandResult> {
  const options = parseMxBuildArgs(args);
  await build(options, io);
  return {
    data: { packages: [...PACKAGES], syncVersions: options.syncVersions === true },
    text: `Built ${PACKAGES.length} packages${options.syncVersions ? ' with synchronized versions' : ''}.`,
  };
}

/** Standalone boundary; reports failures without terminating an embedding process. */
export async function runBuildMain(
  isMain = import.meta.main,
  start: (args: readonly string[], io: CliIo) => Promise<CommandResult> = runMxBuild,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  if (!isMain) return;
  try {
    await start(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
  } catch (error) {
    process.stderr.write(
      `❌ Build failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    setExitCode(error instanceof CommandFailure ? error.exitCode : 1);
  }
}

void runBuildMain();
