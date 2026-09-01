import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import { type CliIo, CommandFailure, type CommandResult, PROCESS_IO } from '../command';
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
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
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

Init scaffolds \`"check": "di-framework check"\` so \`bun run check\` delegates here.

Maintainer monorepo typecheck: di-framework mx typecheck
`);
}

export async function checkApp(
  opts: CheckOptions,
  io: CliIo = PROCESS_IO,
): Promise<{ cwd: string; tool: 'ttsc' | 'tsc'; tsconfigPath: string }> {
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
  io.stdout.write(`ℹ️  Checking with ${tool} --noEmit -p ${tsconfigPath}\n`);

  const prettyFlag = opts.pretty ? [] : ['--pretty', 'false'];
  const proc = useTtsc
    ? await $`bun x ttsc --noEmit -p ${tsconfigPath} ${prettyFlag}`.cwd(opts.cwd).nothrow()
    : await $`bun x tsc --noEmit -p ${tsconfigPath} ${prettyFlag}`.cwd(opts.cwd).nothrow();

  if (proc.exitCode !== 0) {
    throw new Error(`Typecheck failed (exit ${proc.exitCode})`);
  }

  io.stdout.write('✅ Check passed\n');
  return { cwd: opts.cwd, tool, tsconfigPath };
}

export async function check(
  args: string[] = process.argv.slice(3),
  io: CliIo = PROCESS_IO,
): Promise<CommandResult> {
  if (args[0] === '--help' || args[0] === '-h') {
    printCheckHelp(io.stderr as NodeJS.WritableStream);
    return { data: { help: true } };
  }
  let options: CheckOptions;
  try {
    options = parseCheckArgs(args);
  } catch (error) {
    throw new CommandFailure(
      'INVALID_USAGE',
      error instanceof Error ? error.message : String(error),
      2,
    );
  }
  const result = await checkApp(options, io);
  return { data: result };
}

export function handleCheckFailure(
  err: unknown,
  io: CliIo = PROCESS_IO,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): void {
  io.stderr.write(`check failed: ${err instanceof Error ? err.message : String(err)}\n`);
  setExitCode(1);
}

export function runCheckMain(
  isMain = import.meta.main,
  start: () => Promise<unknown> = () => check().catch(handleCheckFailure),
): void {
  if (isMain) void start();
}

runCheckMain();
