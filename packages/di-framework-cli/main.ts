#!/usr/bin/env bun
import { build } from './cmd/build';
import { generateCommand as generate } from './cmd/generate';
import { publish } from './cmd/publish';
import { test } from './cmd/test';
import { typecheck } from './cmd/typecheck';

const COMMANDS: Record<string, { description: string; run: () => Promise<void> }> = {
  generate: { description: 'Generates application surfaces from schema manifests', run: generate },
  build: { description: 'Builds all packages and syncs versions', run: build },
  test: { description: 'Runs the E2E test suite', run: test },
  typecheck: { description: 'Runs TypeScript type checking across packages', run: typecheck },
  publish: { description: 'Publishes all packages to npm', run: publish },
};

async function main() {
  const cmdName = process.argv[2];

  if (!cmdName) {
    console.error('Please provide a command\n');
    console.error('Available commands:');
    for (const [name, { description }] of Object.entries(COMMANDS)) {
      console.error(`  ${name.padEnd(12)} ${description}`);
    }
    process.exit(1);
  }

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    process.exit(1);
  }

  await cmd.run();
}

main().catch((err) => {
  console.error('Failed to execute command:', err.message ?? err);
  process.exit(1);
});
