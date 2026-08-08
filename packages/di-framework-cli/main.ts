#!/usr/bin/env bun
/**
 * di-framework CLI — app tooling by default; monorepo maintainers use `mx`.
 *
 * App:        di-framework init | build | check
 * Maintainer: di-framework mx <build|test|typecheck|publish>
 */
import { build } from './cmd/build';
import { check } from './cmd/check';
import { init } from './cmd/init';
import { mx, printMxHelp } from './cmd/mx';

type Command = {
  description: string;
  run: (args: string[]) => Promise<void>;
};

const COMMANDS: Record<string, Command> = {
  init: {
    description: 'Scaffold a new di-framework application',
    run: (args) => init(args),
  },
  build: {
    description: 'Build the current application (package.json script or tsc)',
    run: (args) => build(args),
  },
  check: {
    description: 'Typecheck the current application',
    run: (args) => check(args),
  },
  mx: {
    description: 'Maintainer tools for the di-framework monorepo',
    run: (args) => mx(args),
  },
};

export function printHelp(stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`di-framework — CLI for apps built with @di-framework/*

Usage:
  di-framework <command> [args...]

Commands:
`);
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    if (name === 'mx') continue;
    stream.write(`  ${name.padEnd(12)} ${description}\n`);
  }
  stream.write(`  ${'mx'.padEnd(12)} Maintainer tools (build / test / typecheck / publish)

Examples:
  di-framework init my-api
  di-framework check
  di-framework build
  di-framework mx build          # monorepo maintainers only

`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmdName, ...args] = argv;

  if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') {
    printHelp();
    if (!cmdName) process.exit(1);
    return;
  }

  // Friendly redirect if someone still types old maintainer commands at top level.
  if (cmdName === 'test' || cmdName === 'typecheck' || cmdName === 'publish') {
    console.error(
      `Note: \`${cmdName}\` is a maintainer command. Use:\n  di-framework mx ${cmdName}\n`,
    );
    await mx([cmdName, ...args]);
    return;
  }

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    console.error(`Unknown command: ${cmdName}\n`);
    printHelp();
    process.exit(1);
  }

  await cmd.run(args);
}

export function handleMainFailure(err: unknown): never {
  console.error('Failed to execute command:', err instanceof Error ? err.message : err);
  process.exit(1);
}

export function runMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => main().catch(handleMainFailure),
): void {
  if (isMain) void start();
}

// re-export for tests that want help for mx without importing cmd/mx
export { printMxHelp };

runMain();
