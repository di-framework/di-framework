import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { normalizeImportPath, normalizeManifest } from '../src/normalize.ts';
import type { SchemaCodegenManifest } from '../src/types.ts';

describe('normalizeImportPath', () => {
  it('calculates correct relative import paths between directories', () => {
    const fromDir = '/app/src/generated/orders/v1';
    const targetPath = '/app/src/contracts/orders.schemas.ts';

    const rel = normalizeImportPath(fromDir, targetPath);
    expect(rel).toBe('../../../contracts/orders.schemas');
  });

  it('prepends ./ for same directory imports', () => {
    const fromDir = '/app/src/generated/orders/v1';
    const targetPath = '/app/src/generated/orders/v1/contracts.ts';

    const rel = normalizeImportPath(fromDir, targetPath);
    expect(rel).toBe('./contracts');
  });
});

describe('normalizeManifest', () => {
  it('normalizes a manifest object into IR', async () => {
    const config = await loadConfig(
      {
        manifests: ['./src/contracts/**/*.codegen.ts'],
        outDir: './src/generated',
        companionsDir: './src/handlers',
      },
      '/app',
    );

    const dummySchema = {
      parse: (val: unknown) => val,
      jsonSchema: { type: 'object' },
    };

    const manifest: SchemaCodegenManifest = {
      name: 'orders',
      version: 'v1',
      schemas: {
        CreateOrder: dummySchema,
        Order: dummySchema,
      },
      http: {
        prefix: '/v1',
      },
      operations: {
        createOrder: {
          input: 'CreateOrder',
          output: 'Order',
          handler: {
            module: '../handlers/order.handlers',
            export: 'OrderHandlers',
            method: 'createOrder',
          },
          http: {
            method: 'POST',
            path: '/orders',
            successStatus: 201,
          },
          rpc: {
            package: 'orders.v1',
            service: 'OrdersService',
            inputFields: {
              customerId: 1,
              amount: { number: 2, type: 'double' },
            },
            outputFields: {
              id: 1,
            },
          },
        },
      },
    };

    const norm = normalizeManifest(
      {
        manifest,
        filePath: '/app/src/contracts/orders-v1.codegen.ts',
      },
      config,
    );

    expect(norm.name).toBe('orders');
    expect(norm.version).toBe('v1');
    expect(norm.httpPrefix).toBe('/v1');

    const op = norm.operations.createOrder;
    expect(op).toBeDefined();
    expect(op?.inputSchemaName).toBe('CreateOrder');
    expect(op?.outputSchemaName).toBe('Order');
    expect(op?.handler.relativeModulePathFromGen).toBe('../../../handlers/order.handlers');
    expect(op?.http?.method).toBe('POST');
    expect(op?.rpc?.inputFields.amount?.type).toBe('double');
  });
});
