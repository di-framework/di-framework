import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ as defaultShell } from 'bun';

export type AppBuildOptions = {
  cwd: string;
  /** Extra args forwarded to the underlying build tool */
  passthrough: string[];
};

/** Bun `$` tagged-template runner; injectable for coverage tests. */
export type BuildShell = typeof defaultShell;

export function parseBuildArgs(args: string[], cwd = process.cwd()): AppBuildOptions {
  return {
    cwd: resolve(cwd),
    passthrough: args.filter((a) => a !== '--help' && a !== '-h'),
  };
}

export function printBuildHelp(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`Build the current di-framework application.

Usage:
  di-framework build [args...]

Runs, in order of preference:
  1. package.json "build" script  (bun run build / npm run build)
  2. ttsc --emit -p tsconfig.json if ttsc is installed (or declared)
  3. tsc -p tsconfig.json         if tsconfig exists and no build script

Maintainer monorepo build: di-framework mx build
`);
}

export function detectPackageManager(cwd: string): 'bun' | 'npm' | 'pnpm' | 'yarn' {
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return existsSync(join(cwd, 'package-lock.json')) ? 'npm' : 'bun';
}

export function hasTtsc(
  cwd: string,
  pkg?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
): boolean {
  if (pkg?.dependencies?.ttsc || pkg?.devDependencies?.ttsc) return true;
  return existsSync(join(cwd, 'node_modules', 'ttsc'));
}

export async function buildApp(
  opts: AppBuildOptions,
  shell: BuildShell = defaultShell,
): Promise<void> {
  if (opts.passthrough.includes('--help') || opts.passthrough.includes('-h')) {
    printBuildHelp();
    return;
  }

  const pkgPath = join(opts.cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(
      `No package.json in ${opts.cwd}. Run \`di-framework init\` first, or cd into your app.`,
    );
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const hasBuildScript = Boolean(pkg.scripts?.build);
  const tsconfig = join(opts.cwd, 'tsconfig.json');
  const pm = detectPackageManager(opts.cwd);

  if (hasBuildScript) {
    console.log(`Building with ${pm} run build…`);
    if (pm === 'bun') {
      await shell`bun run build ${opts.passthrough}`.cwd(opts.cwd);
    } else if (pm === 'pnpm') {
      await shell`pnpm run build ${opts.passthrough}`.cwd(opts.cwd);
    } else if (pm === 'yarn') {
      await shell`yarn run build ${opts.passthrough}`.cwd(opts.cwd);
    } else {
      await shell`npm run build -- ${opts.passthrough}`.cwd(opts.cwd);
    }
    console.log('✅ Build finished');
    return;
  }

  if (existsSync(tsconfig)) {
    if (hasTtsc(opts.cwd, pkg)) {
      console.log('No "build" script; running ttsc --emit -p tsconfig.json…');
      await shell`bun x ttsc --emit -p ${tsconfig} ${opts.passthrough}`.cwd(opts.cwd);
    } else {
      console.log('No "build" script; running tsc -p tsconfig.json…');
      await shell`bun x tsc -p ${tsconfig} ${opts.passthrough}`.cwd(opts.cwd);
    }
    console.log('✅ Build finished');
    return;
  }

  throw new Error(
    'Nothing to build: add a "build" script to package.json or a tsconfig.json. ' +
      'Or scaffold with `di-framework init`.',
  );
}

export async function build(args: string[] = process.argv.slice(3)): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    printBuildHelp();
    return;
  }
  await buildApp(parseBuildArgs(args));
}

export function handleBuildFailure(err: unknown): never {
  console.error('build failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

export function runBuildMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => build().catch(handleBuildFailure),
): void {
  if (isMain) void start();
}

runBuildMain();
