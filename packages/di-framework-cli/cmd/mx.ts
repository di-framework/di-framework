/**
 * Maintainer tooling for the di-framework monorepo (`mx` = maintainer).
 * App authors should use top-level `init` / `build` / `check` instead.
 */
import { build } from './mx/build';
import { publish } from './mx/publish';
import { test } from './mx/test';
import { typecheck } from './mx/typecheck';

export const MX_COMMANDS: Record<string, { description: string; run: () => Promise<void> }> = {
  build: { description: 'Build all monorepo packages and sync versions', run: build },
  test: { description: 'Run the monorepo E2E test suite', run: test },
  typecheck: { description: 'Typecheck the monorepo with the language service', run: typecheck },
  publish: { description: 'Test, build, and publish all packages to npm', run: publish },
};

export function printMxHelp(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write('Maintainer commands (di-framework monorepo):\n\n');
  stream.write('  di-framework mx <command>\n\n');
  for (const [name, { description }] of Object.entries(MX_COMMANDS)) {
    stream.write(`  ${name.padEnd(12)} ${description}\n`);
  }
  stream.write('\nApp commands: di-framework init | build | check\n');
}

/**
 * Run a maintainer subcommand.
 * Rewrites process.argv so nested tools that parse argv (e.g. typecheck) see
 * `di-framework mx typecheck …` as if typecheck were the program.
 */
export async function mx(args: string[] = process.argv.slice(3)): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printMxHelp();
    if (!sub) process.exit(1);
    return;
  }

  const cmd = MX_COMMANDS[sub];
  if (!cmd) {
    console.error(`Unknown mx command: ${sub}\n`);
    printMxHelp();
    process.exit(1);
  }

  // Drop `mx <sub>` so nested argv parsers only see their own flags/paths.
  const rest = args.slice(1);
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await cmd.run();
}

export function handleMxFailure(err: unknown): never {
  console.error('mx command failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

export function runMxMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => mx().catch(handleMxFailure),
): void {
  if (isMain) void start();
}

runMxMain();
