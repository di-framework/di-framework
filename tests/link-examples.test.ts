import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExamplesDir } from '../scripts/link-examples';

describe('link-examples script', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'link-examples-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.EXAMPLES_DIR;
  });

  it('resolves nested examples directory if present', () => {
    const nested = join(tempDir, 'examples');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'examples' }));

    const resolved = resolveExamplesDir(tempDir);
    expect(resolved).toBe(nested);
  });

  it('resolves sibling examples directory if nested is absent', () => {
    const root = join(tempDir, 'repo');
    const sibling = join(tempDir, 'examples');
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'package.json'), JSON.stringify({ name: 'examples' }));

    const resolved = resolveExamplesDir(root);
    expect(resolved).toBe(sibling);
  });

  it('honors EXAMPLES_DIR environment variable override', () => {
    const custom = join(tempDir, 'custom-examples');
    mkdirSync(custom, { recursive: true });
    process.env.EXAMPLES_DIR = custom;

    const resolved = resolveExamplesDir(tempDir);
    expect(resolved).toBe(custom);
  });

  it('throws an error if examples directory cannot be found', () => {
    const emptyDir = join(tempDir, 'isolated');
    mkdirSync(emptyDir, { recursive: true });

    expect(() => resolveExamplesDir(emptyDir)).toThrow('Could not locate examples workspace');
  });
});
