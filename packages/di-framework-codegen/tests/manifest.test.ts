import { describe, expect, it } from 'bun:test';
import { validateManifestShape } from '../src/manifest.ts';

describe('validateManifestShape', () => {
  it('passes for a valid manifest object', () => {
    const validManifest = {
      name: 'orders',
      version: 'v1',
      schemas: {},
      operations: {
        createOrder: {
          input: 'CreateOrder',
          output: 'Order',
          handler: {
            module: '../handlers/order.handlers',
            export: 'OrderHandlers',
            method: 'createOrder',
          },
        },
      },
    };

    expect(() => validateManifestShape(validManifest, 'test.ts')).not.toThrow();
  });

  it('throws when manifest is missing name or version', () => {
    expect(() => validateManifestShape({}, 'test.ts')).toThrow(/'name'/);
    expect(() => validateManifestShape({ name: 'orders' }, 'test.ts')).toThrow(/'version'/);
  });

  it('throws when operations have missing handlers', () => {
    const invalidManifest = {
      name: 'orders',
      version: 'v1',
      schemas: {},
      operations: {
        createOrder: {
          input: 'CreateOrder',
          output: 'Order',
        },
      },
    };

    expect(() => validateManifestShape(invalidManifest, 'test.ts')).toThrow(/'handler'/);
  });
});
