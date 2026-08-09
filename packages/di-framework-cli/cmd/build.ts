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
  1. ttsc --emit -p tsconfig.json  if ttsc is installed (or declared)
  2. tsc -p tsconfig.json          if tsconfig.json exists

Init scaffolds \`\"build\": \"di-framework build\"\` so \`bun run build\` delegates here.

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
  if (pkg?.dependencies?.['@di-framework/tsc'] || pkg?.devDependencies?.['@di-framework/tsc']) {
    return true;
  }
  if (existsSync(join(cwd, 'node_modules', 'ttsc'))) return true;
  if (existsSync(join(cwd, 'node_modules', '@di-framework', 'tsc'))) return true;
  return existsSync(join(cwd, 'node_modules', '@di-framework', 'tsc', 'node_modules', 'ttsc'));
}

export function readPkgJson(cwd: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  return JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

export async function buildApp(
  opts: AppBuildOptions,
  shell: BuildShell = defaultShell,
): Promise<void> {
  if (opts.passthrough.includes('--help') || opts.passthrough.includes('-h')) {
    printBuildHelp();
    return;
  }

  const pkg = readPkgJson(opts.cwd);
  if (!pkg) {
    throw new Error(
      `No package.json in ${opts.cwd}. Run \`di-framework init\` first, or cd into your app.`,
    );
  }

  const tsconfig = join(opts.cwd, 'tsconfig.json');
  if (!existsSync(tsconfig)) {
    throw new Error(
      'Nothing to build: add a tsconfig.json, or scaffold with `di-framework init`.',
    );
  }

  if (hasTtsc(opts.cwd, pkg)) {
    console.log('Building with ttsc --emit -p tsconfig.json…');
    await shell`bun x ttsc --emit -p ${tsconfig} ${opts.passthrough}`.cwd(opts.cwd);
  } else {
    console.log('Building with tsc -p tsconfig.json…');
    await shell`bun x tsc -p ${tsconfig} ${opts.passthrough}`.cwd(opts.cwd);
  }
  console.log('✅ Build finished');
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
