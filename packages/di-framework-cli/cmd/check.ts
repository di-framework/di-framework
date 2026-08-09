import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import { hasTtsc, readPkgJson } from './build';

export type CheckOptions = {
  cwd: string;
  tsconfigPath?: string;
  pretty: boolean;
};

/**
 * Prefer the nearest tsconfig.json walking up from cwd (app project),
 * stopping at a .git root or filesystem root.
 */
export function findNearestTsconfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;

    const gitPath = join(dir, '.git');
    if (existsSync(gitPath)) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function parseCheckArgs(args: string[], cwd = process.cwd()): CheckOptions {
  let tsconfigPath: string | undefined;
  let pretty = Boolean(process.stdout.isTTY);

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') continue;
    if (arg.startsWith('--pretty=')) {
      pretty = arg.split('=')[1] !== '0';
      continue;
    }
    if (arg === '--pretty') {
      pretty = true;
      continue;
    }
    if (arg === '--no-pretty') {
      pretty = false;
      continue;
    }
    if (!arg.startsWith('-') && !tsconfigPath) {
      tsconfigPath = arg;
    }
  }

  return { cwd: resolve(cwd), tsconfigPath, pretty };
}

export function printCheckHelp(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`Typecheck the current di-framework application.

Usage:
  di-framework check [tsconfig.json] [options]

Options:
  --pretty=0|--no-pretty   Disable colored diagnostics (tsc fallback only)
  --help, -h               Show this help

Runs, in order of preference:
  1. ttsc --noEmit -p <tsconfig>  if ttsc is installed (or declared)
  2. tsc --noEmit -p <tsconfig>   nearest tsconfig.json (or the path given)

Init scaffolds \`\"check\": \"di-framework check\"\` so \`bun run check\` delegates here.

Maintainer monorepo typecheck: di-framework mx typecheck
`);
}

export async function checkApp(opts: CheckOptions): Promise<void> {
  const tsconfigPath = opts.tsconfigPath
    ? resolve(opts.cwd, opts.tsconfigPath)
    : findNearestTsconfig(opts.cwd);

  if (!tsconfigPath || !existsSync(tsconfigPath)) {
    throw new Error(
      'Could not find tsconfig.json. Pass a path, or run `di-framework init` to scaffold one.',
    );
  }

  const pkg = readPkgJson(opts.cwd);
  const useTtsc = hasTtsc(opts.cwd, pkg ?? undefined);
  const tool = useTtsc ? 'ttsc' : 'tsc';
  console.log(`ℹ️  Checking with ${tool} --noEmit -p ${tsconfigPath}`);

  const prettyFlag = opts.pretty ? [] : ['--pretty', 'false'];
  const proc = useTtsc
    ? await $`bun x ttsc --noEmit -p ${tsconfigPath} ${prettyFlag}`.cwd(opts.cwd).nothrow()
    : await $`bun x tsc --noEmit -p ${tsconfigPath} ${prettyFlag}`.cwd(opts.cwd).nothrow();

  if (proc.exitCode !== 0) {
    throw new Error(`Typecheck failed (exit ${proc.exitCode})`);
  }

  console.log('✅ Check passed');
}

export async function check(args: string[] = process.argv.slice(3)): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    printCheckHelp();
    return;
  }
  await checkApp(parseCheckArgs(args));
}

export function handleCheckFailure(err: unknown): never {
  console.error('check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

export function runCheckMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => check().catch(handleCheckFailure),
): void {
  if (isMain) void start();
}

runCheckMain();
