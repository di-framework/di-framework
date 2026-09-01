import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

export type MxBuildOptions = {
  /** Copy the workspace root version into each package.json. Off by default so install/CI compile does not dirty trees. */
  syncVersions?: boolean;
  /** Workspace to build. Defaults to the current working directory. */
  workspaceRoot?: string;
};

export function parseMxBuildArgs(args: string[] = process.argv.slice(2)): MxBuildOptions {
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
  'packages/di-framework-cli',
  // plugin.cjs + Go sidecar; package.json "build" is a no-op (not tsc/bun compile)
  'packages/di-framework-tsc',
];

export async function build(options: MxBuildOptions = {}) {
  console.log('🚀 Starting build process...');

  const syncVersions = options.syncVersions === true;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  let version: string | undefined;
  if (syncVersions) {
    const rootPkgPath = join(workspaceRoot, 'package.json');
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    version = rootPkg.version;
    console.log(`📌 Using version ${version} from workspace root`);
  }

  for (const pkgDir of PACKAGES) {
    console.log(`\n📦 Building ${pkgDir}...`);
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

    // 1. Clean dist
    await $`rm -rf ${join(fullPath, 'dist')}`;

    // 2. Run build
    console.log('  Running build...');
    if (existsSync(join(fullPath, 'tsconfig.build.json'))) {
      await $`cd ${fullPath} && bun x tsc -p tsconfig.build.json`;
    } else {
      await $`cd ${fullPath} && bun run build`;
    }

    console.log(`  ✅ Finished building ${pkgDir}`);
  }

  console.log('\n✨ All builds completed successfully!');
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handleBuildFailure(err: unknown): never {
  console.error('❌ Build failed:', err);
  process.exit(1);
}

/** CLI main gate — `isMain` is injectable so tests can cover the entry path. */
export function runBuildMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => build(parseMxBuildArgs()).catch(handleBuildFailure),
): void {
  if (isMain) {
    void start();
  }
}

runBuildMain();
