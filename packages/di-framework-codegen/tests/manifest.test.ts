import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { loadLedger, saveLedger } from '../src/ledger.ts';
import { findManifestFiles, loadManifests, validateManifestShape } from '../src/manifest.ts';

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

  it('throws when manifest is missing name, version, schemas, or operations', () => {
    expect(() => validateManifestShape(null, 'test.ts')).toThrow(/object/);
    expect(() => validateManifestShape({}, 'test.ts')).toThrow(/'name'/);
    expect(() => validateManifestShape({ name: 'orders' }, 'test.ts')).toThrow(/'version'/);
    expect(() => validateManifestShape({ name: 'orders', version: 'v1' }, 'test.ts')).toThrow(
      /'schemas'/,
    );
    expect(() =>
      validateManifestShape({ name: 'orders', version: 'v1', schemas: {} }, 'test.ts'),
    ).toThrow(/'operations'/);
  });

  it('throws when operations or operation properties are invalid', () => {
    expect(() =>
      validateManifestShape(
        { name: 'orders', version: 'v1', schemas: {}, operations: { op1: null } },
        'test.ts',
      ),
    ).toThrow(/must be an object/);

    expect(() =>
      validateManifestShape(
        { name: 'orders', version: 'v1', schemas: {}, operations: { op1: {} } },
        'test.ts',
      ),
    ).toThrow(/missing 'input'/);

    expect(() =>
      validateManifestShape(
        { name: 'orders', version: 'v1', schemas: {}, operations: { op1: { input: 'A' } } },
        'test.ts',
      ),
    ).toThrow(/missing 'output'/);

    expect(() =>
      validateManifestShape(
        {
          name: 'orders',
          version: 'v1',
          schemas: {},
          operations: { op1: { input: 'A', output: 'B', handler: 'invalid' } },
        },
        'test.ts',
      ),
    ).toThrow(/'handler'/);
  });
});

describe('findManifestFiles, loadManifests, and loadLedger', () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('discovers manifest files via direct file path and glob traversal', async () => {
    testDir = join(tmpdir(), `manifest-find-${Date.now()}`);
    const subDir = join(testDir, 'src', 'contracts');
    mkdirSync(subDir, { recursive: true });

    const manifestPath = join(subDir, 'test-v1.codegen.ts');
    writeFileSync(
      manifestPath,
      `export default {
  name: 'test',
  version: 'v1',
  schemas: {},
  operations: {},
};`,
      'utf-8',
    );

    // Direct file path match
    const directFound = findManifestFiles([manifestPath], testDir);
    expect(directFound).toEqual([manifestPath]);

    // Pattern match
    const found = findManifestFiles(['./src/**/*.codegen.ts'], testDir);
    expect(found.length).toBeGreaterThan(0);

    const loaded = await loadManifests(['./src/**/*.codegen.ts'], testDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.manifest.name).toBe('test');
  });

  it('loadConfig handles missing files and candidate auto-discovery', async () => {
    testDir = join(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    expect(loadConfig('./non-existent.ts', testDir)).rejects.toThrow(/not found/);

    // Write candidate file
    const candidatePath = join(testDir, 'di-framework.codegen.ts');
    writeFileSync(
      candidatePath,
      `export default { manifests: ['./custom/**/*.codegen.ts'] };`,
      'utf-8',
    );

    const loadedCfg = await loadConfig(undefined, testDir);
    expect(loadedCfg.manifests).toEqual(['./custom/**/*.codegen.ts']);
  });

  it('loadLedger handles corrupt JSON files and saveLedger creates parent dir', () => {
    testDir = join(tmpdir(), `ledger-test-${Date.now()}`);
    const corruptPath = join(testDir, 'corrupt.json');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(corruptPath, '{ corrupt json', 'utf-8');

    const ledger = loadLedger(corruptPath);
    expect(ledger.version).toBe('1');
    expect(ledger.generatedFiles).toEqual([]);

    const newLedgerPath = join(testDir, 'sub', 'ledger.json');
    saveLedger(newLedgerPath, ['a.ts']);
    expect(existsSync(newLedgerPath)).toBe(true);
  });
});
