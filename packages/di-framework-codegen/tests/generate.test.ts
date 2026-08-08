import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../index.ts';
import { hasOwnershipHeader, loadLedger } from '../src/ledger.ts';
import type { SchemaCodegenManifest } from '../src/types.ts';

describe('generate() API', () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function setupTestWorkspace() {
    testDir = join(tmpdir(), `codegen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Write schema file
    const schemaDir = join(testDir, 'src', 'contracts');
    mkdirSync(schemaDir, { recursive: true });

    const schemaContent = `export const CreateOrder = {
  parse(input: unknown) { return input; },
  jsonSchema: { type: 'object' },
};
export const Order = {
  parse(input: unknown) { return input; },
  jsonSchema: { type: 'object' },
};
`;
    writeFileSync(join(schemaDir, 'orders.schemas.ts'), schemaContent, 'utf-8');

    const manifest: SchemaCodegenManifest = {
      name: 'orders',
      version: 'v1',
      schemas: {
        CreateOrder: {
          schema: {
            parse: (i: unknown) => i,
            jsonSchema: { type: 'object' },
          },
          module: './orders.schemas.ts',
        },
        Order: {
          schema: {
            parse: (i: unknown) => i,
            jsonSchema: { type: 'object' },
          },
          module: './orders.schemas.ts',
        },
      },
      http: { prefix: '/v1' },
      operations: {
        createOrder: {
          input: 'CreateOrder',
          output: 'Order',
          handler: {
            module: '../handlers/order.handlers.ts',
            export: 'OrderHandlers',
            method: 'createOrder',
          },
          http: {
            method: 'POST',
            path: '/orders',
            successStatus: 201,
          },
          events: {
            inbound: {
              topic: 'orders.create.v1',
              event: 'order.create.requested.v1',
            },
          },
          rpc: {
            package: 'orders.v1',
            service: 'OrdersService',
            inputFields: { customerId: 1 },
            outputFields: { id: 1 },
          },
          tool: {
            name: 'create_order',
            description: 'Create an order',
          },
          authorization: {
            resource: 'order',
            action: 'create',
            policyModule: '../policies/order.policy.ts',
          },
        },
      },
    };

    return { testDir, manifest };
  }

  it('generates deterministic surface files and records ledger', async () => {
    const { testDir, manifest } = setupTestWorkspace();

    const res1 = await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
    });

    expect(res1.success).toBe(true);
    expect(res1.drifted).toBe(false);

    const contractsPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'contracts.ts');
    const httpPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'http.ts');
    const eventsPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'events.ts');
    const rpcPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'rpc.ts');
    const toolsPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'tools.ts');
    const ledgerPath = join(testDir, 'src', 'generated', '.codegen-ledger.json');

    expect(existsSync(contractsPath)).toBe(true);
    expect(existsSync(httpPath)).toBe(true);
    expect(existsSync(eventsPath)).toBe(true);
    expect(existsSync(rpcPath)).toBe(true);
    expect(existsSync(toolsPath)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(true);

    const contracts1 = readFileSync(contractsPath, 'utf-8');
    expect(hasOwnershipHeader(contracts1)).toBe(true);

    // Run a second time: should be 100% byte-for-byte identical and unchanged
    const res2 = await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
    });

    expect(res2.success).toBe(true);
    const contracts2 = readFileSync(contractsPath, 'utf-8');
    expect(contracts1).toBe(contracts2);
  });

  it('--check reports drift without writing files when content is modified or file is missing', async () => {
    const { testDir, manifest } = setupTestWorkspace();

    // 1. Missing file check
    const checkRes1 = await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
      check: true,
    });

    expect(checkRes1.success).toBe(false);
    expect(checkRes1.drifted).toBe(true);

    // Write files
    await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
    });

    // Modify a generated file
    const contractsPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'contracts.ts');
    writeFileSync(contractsPath, '// modified content', 'utf-8');

    // Check mode on modified file
    const checkRes2 = await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
      check: true,
    });

    expect(checkRes2.success).toBe(false);
    expect(checkRes2.drifted).toBe(true);

    // Write mode on modified file (updates file)
    const writeRes = await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
    });
    expect(writeRes.success).toBe(true);
    expect(readFileSync(contractsPath, 'utf-8')).not.toBe('// modified content');
  });

  it('--init creates missing companion handler and policy files once without overwriting existing ones', async () => {
    const { testDir, manifest } = setupTestWorkspace();

    const handlerPath = join(testDir, 'src', 'handlers', 'order.handlers.ts');
    const policyPath = join(testDir, 'src', 'policies', 'order.policy.ts');

    expect(existsSync(handlerPath)).toBe(false);
    expect(existsSync(policyPath)).toBe(false);

    // Run generate with --init
    await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
      init: true,
    });

    expect(existsSync(handlerPath)).toBe(true);
    expect(existsSync(policyPath)).toBe(true);

    // Edit handler file by hand
    writeFileSync(handlerPath, '// Hand-edited application logic', 'utf-8');

    // Run generate with --init again
    await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
      init: true,
    });

    // Content of handler file must NOT be overwritten!
    const handlerContent = readFileSync(handlerPath, 'utf-8');
    expect(handlerContent).toBe('// Hand-edited application logic');
  });

  it('safely cleans up stale files only if recorded in ledger and carrying ownership header', async () => {
    const { testDir, manifest } = setupTestWorkspace();

    // Initial generate
    await generate({
      cwd: testDir,
      manifests: [manifest],
      outDir: './src/generated',
    });

    const oldEventsPath = join(testDir, 'src', 'generated', 'orders', 'v1', 'events.ts');
    expect(existsSync(oldEventsPath)).toBe(true);

    const updatedManifest: SchemaCodegenManifest = {
      ...manifest,
      operations: {
        createOrder: {
          ...manifest.operations.createOrder!,
          events: undefined, // remove events
        },
      },
    };

    // Stale check mode test
    const checkRes = await generate({
      cwd: testDir,
      manifests: [updatedManifest],
      outDir: './src/generated',
      check: true,
    });
    expect(checkRes.drifted).toBe(true);
    expect(existsSync(oldEventsPath)).toBe(true);

    // Write mode without clean option preserves stale file and emits diagnostic
    const noCleanRes = await generate({
      cwd: testDir,
      manifests: [updatedManifest],
      outDir: './src/generated',
    });
    expect(noCleanRes.success).toBe(true);
    expect(existsSync(oldEventsPath)).toBe(true);
    expect(noCleanRes.diagnostics.some((d) => d.includes('Use --clean to remove'))).toBe(true);

    // Clean up stale file in write mode with clean: true
    const writeRes = await generate({
      cwd: testDir,
      manifests: [updatedManifest],
      outDir: './src/generated',
      clean: true,
    });
    expect(writeRes.success).toBe(true);
    expect(existsSync(oldEventsPath)).toBe(false);

    // Test skipping cleanup when ownership header is missing
    const fakeStalePath = join(testDir, 'src', 'generated', 'orders', 'v1', 'stale.ts');
    writeFileSync(fakeStalePath, '// hand written without header', 'utf-8');
    const ledgerPath = join(testDir, 'src', 'generated', '.codegen-ledger.json');

    // Add fakeStalePath to ledger
    const ledger = loadLedger(ledgerPath);
    ledger.generatedFiles.push('src/generated/orders/v1/stale.ts');
    writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf-8');

    const skipRes = await generate({
      cwd: testDir,
      manifests: [updatedManifest],
      outDir: './src/generated',
      clean: true,
    });
    expect(skipRes.diagnostics.some((d) => d.includes('missing codegen ownership header'))).toBe(
      true,
    );
    expect(existsSync(fakeStalePath)).toBe(true);
  });
});
