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

  it('prepends ./ for same directory imports or absolute targets', () => {
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
            module: '/app/src/handlers/order.handlers.ts',
            export: 'OrderHandlers',
            method: 'createOrder',
          },
          http: {
            method: 'POST',
            path: '/orders',
            summary: 'Create order',
            description: 'Create an order in system',
          },
          events: {
            inbound: {
              topic: 'orders.create.v1',
              event: 'order.create.requested.v1',
            },
            outbound: {
              topic: 'orders.created.v1',
              event: 'order.created.v1',
            },
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
          authorization: {
            resource: 'order',
            action: 'create',
            policyModule: '/app/src/policies/order.policy.ts',
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
    expect(op?.http?.summary).toBe('Create order');
    expect(op?.events?.outbound?.event).toBe('order.created.v1');
    expect(op?.rpc?.inputFields.amount?.type).toBe('double');
  });

  it('throws on invalid schema definition or unknown input/output schema references', async () => {
    const config = await loadConfig(
      {
        manifests: [],
        outDir: './src/generated',
      },
      '/app',
    );

    const invalidSchemaManifest: any = {
      name: 'orders',
      version: 'v1',
      schemas: {
        BadSchema: {},
      },
      operations: {},
    };

    expect(() =>
      normalizeManifest({ manifest: invalidSchemaManifest, filePath: '/app/manifest.ts' }, config),
    ).toThrow(/Invalid schema definition/);

    const unknownInputManifest: any = {
      name: 'orders',
      version: 'v1',
      schemas: {
        Order: { parse: (i: any) => i, jsonSchema: {} },
      },
      operations: {
        op1: {
          input: 'UnknownInput',
          output: 'Order',
          handler: { module: './h', export: 'H', method: 'm' },
        },
      },
    };

    expect(() =>
      normalizeManifest({ manifest: unknownInputManifest, filePath: '/app/manifest.ts' }, config),
    ).toThrow(/unknown input schema/);

    const unknownOutputManifest: any = {
      name: 'orders',
      version: 'v1',
      schemas: {
        CreateOrder: { parse: (i: any) => i, jsonSchema: {} },
      },
      operations: {
        op1: {
          input: 'CreateOrder',
          output: 'UnknownOutput',
          handler: { module: './h', export: 'H', method: 'm' },
        },
      },
    };

    expect(() =>
      normalizeManifest({ manifest: unknownOutputManifest, filePath: '/app/manifest.ts' }, config),
    ).toThrow(/unknown output schema/);
  });
});
