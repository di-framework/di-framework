import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCommand } from '../cmd/generate';
import type { CliIo, CommandResult } from '../command';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

async function withExitCapture(fn: () => Promise<CommandResult>): Promise<number> {
  return (await fn()).exitCode ?? 0;
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

describe('CLI generate command', () => {
  let testDir: string;
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    try {
      process.chdir(REPO_ROOT);
    } catch {
      /* ignore */
    }
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function setupWorkspace() {
    testDir = join(tmpdir(), `cli-gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Write schema file
    const schemaDir = join(testDir, 'src', 'contracts');
    mkdirSync(schemaDir, { recursive: true });

    writeFileSync(
      join(schemaDir, 'orders.schemas.ts'),
      `export const CreateOrder = { parse: (i: any) => i, jsonSchema: {} };
export const Order = { parse: (i: any) => i, jsonSchema: {} };
`,
      'utf-8',
    );

    // Write manifest file
    writeFileSync(
      join(schemaDir, 'orders-v1.codegen.ts'),
      `export default {
  name: 'orders',
  version: 'v1',
  schemas: {
    CreateOrder: { schema: { parse: String, jsonSchema: {} }, module: './orders.schemas.ts' },
    Order: { schema: { parse: String, jsonSchema: {} }, module: './orders.schemas.ts' },
  },
  http: { prefix: '/v1' },
  operations: {
    createOrder: {
      input: 'CreateOrder',
      output: 'Order',
      handler: { module: '../handlers/order.handlers.ts', export: 'OrderHandlers', method: 'createOrder' },
      http: { method: 'POST', path: '/orders', successStatus: 201 },
    },
  },
};
`,
      'utf-8',
    );

    // Write config file
    writeFileSync(
      join(testDir, 'di-framework.codegen.ts'),
      `export default {
  manifests: ['./src/contracts/**/*.codegen.ts'],
  outDir: './src/generated',
};
`,
      'utf-8',
    );

    return testDir;
  }

  it('parses flags correctly (--config, --outDir, --clean, --init)', async () => {
    const cwd = setupWorkspace();
    process.chdir(cwd);

    const configPath = join(cwd, 'di-framework.codegen.ts');
    const outDir = join(cwd, 'src', 'generated');

    process.argv = [
      'bun',
      'main.ts',
      'generate',
      '--config',
      configPath,
      '--outDir',
      outDir,
      '--clean',
      '--init',
    ];

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const exitCode = await withExitCapture(() => generateCommand());
      expect(exitCode).toBe(0);

      const contractsPath = join(cwd, 'src', 'generated', 'orders', 'v1', 'contracts.ts');
      expect(existsSync(contractsPath)).toBe(true);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('prints info diagnostics on non-drifted generation with unowned stale files', async () => {
    const cwd = setupWorkspace();
    process.chdir(cwd);

    // First generate
    const configPath = join(cwd, 'di-framework.codegen.ts');
    process.argv = ['bun', 'main.ts', 'generate', `--config=${configPath}`];

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withExitCapture(() => generateCommand());

      // Create a stale file in ledger without header
      const staleFile = join(cwd, 'src', 'generated', 'orders', 'v1', 'unowned.ts');
      writeFileSync(staleFile, '// no ownership header', 'utf-8');

      const ledgerPath = join(cwd, 'src', 'generated', '.codegen-ledger.json');
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      ledger.generatedFiles.push('src/generated/orders/v1/unowned.ts');
      writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf-8');

      // Generate again
      const captured = captureIo();
      const exitCode = await withExitCapture(() =>
        generateCommand(process.argv.slice(3), captured.io),
      );
      expect(exitCode).toBe(0);
      expect(captured.stdout.join('')).toContain('ℹ️');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('runs di-framework generate --check and exits non-zero on drift', async () => {
    const cwd = setupWorkspace();
    process.chdir(cwd);

    process.argv = [
      'bun',
      'main.ts',
      'generate',
      '--check',
      '--config=./di-framework.codegen.ts',
      '--outDir=./src/generated',
    ];

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const exitCode = await withExitCapture(() => generateCommand());
      expect(exitCode).toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
