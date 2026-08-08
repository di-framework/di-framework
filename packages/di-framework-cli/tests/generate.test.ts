import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCommand } from '../cmd/generate';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

async function withExitCapture(fn: () => Promise<void>): Promise<number> {
  const originalExit = process.exit;
  let exitCode = 0;
  (process as any).exit = (code: number) => {
    exitCode = code;
    throw new Error(`EXIT_${code}`);
  };
  try {
    await fn();
    return 0;
  } catch (err: any) {
    if (!String(err?.message ?? err).startsWith('EXIT_')) throw err;
    return exitCode;
  } finally {
    process.exit = originalExit;
  }
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
    CreateOrder: { schema: { parse: (i) => i, jsonSchema: {} }, module: './orders.schemas.ts' },
    Order: { schema: { parse: (i) => i, jsonSchema: {} }, module: './orders.schemas.ts' },
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

  it('runs di-framework generate --init and produces generated surfaces and companion files', async () => {
    const cwd = setupWorkspace();
    process.chdir(cwd);

    process.argv = ['bun', 'main.ts', 'generate', '--init', '--config=./di-framework.codegen.ts'];

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const exitCode = await withExitCapture(() => generateCommand());
      expect(exitCode).toBe(0);

      const contractsPath = join(cwd, 'src', 'generated', 'orders', 'v1', 'contracts.ts');
      const httpPath = join(cwd, 'src', 'generated', 'orders', 'v1', 'http.ts');
      const handlerPath = join(cwd, 'src', 'handlers', 'order.handlers.ts');

      expect(existsSync(contractsPath)).toBe(true);
      expect(existsSync(httpPath)).toBe(true);
      expect(existsSync(handlerPath)).toBe(true);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('runs di-framework generate --check and exits non-zero on drift', async () => {
    const cwd = setupWorkspace();
    process.chdir(cwd);

    process.argv = ['bun', 'main.ts', 'generate', '--check', '--config=./di-framework.codegen.ts'];

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
