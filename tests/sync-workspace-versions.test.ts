import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'sync-workspace-versions.mjs');

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('sync-workspace-versions', () => {
  it('writes the release version into each top-level workspace package', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-versions-'));
    try {
      mkdirSync(join(root, 'packages', 'core'), { recursive: true });
      mkdirSync(join(root, 'packages', 'cli', 'fixture'), { recursive: true });
      mkdirSync(join(root, 'packages', 'notes'), { recursive: true });
      writeJson(join(root, 'packages', 'core', 'package.json'), {
        name: '@di-framework/core',
        version: '5.3.7',
        private: false,
      });
      writeJson(join(root, 'packages', 'cli', 'package.json'), {
        name: '@di-framework/cli',
        version: '6.0.0',
        description: 'keep me',
      });
      const nested = join(root, 'packages', 'cli', 'fixture', 'package.json');
      writeFileSync(nested, '{ "name": "fixture", "version": "0.0.0" }\n');
      writeFileSync(join(root, 'packages', 'notes', 'README.md'), 'not a package\n');
      const already = join(root, 'packages', 'cli', 'package.json');
      mkdirSync(join(root, 'packages', 'same'));
      const sameManifest = '{\n  "name": "@di-framework/same",\n  "version": "5.3.8"\n}\n';
      writeFileSync(join(root, 'packages', 'same', 'package.json'), sameManifest);

      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NEXT: '5.3.8' },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Set 2 workspace package version(s) to 5.3.8');
      expect(
        JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8')),
      ).toEqual({ name: '@di-framework/core', version: '5.3.8', private: false });
      expect(JSON.parse(readFileSync(already, 'utf8'))).toEqual({
        name: '@di-framework/cli',
        version: '5.3.8',
        description: 'keep me',
      });
      expect(readFileSync(nested, 'utf8')).toBe('{ "name": "fixture", "version": "0.0.0" }\n');
      expect(readFileSync(join(root, 'packages', 'same', 'package.json'), 'utf8')).toBe(
        sameManifest,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when NEXT is not set', () => {
    const env = { ...process.env };
    delete env.NEXT;
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: import.meta.dir,
      encoding: 'utf8',
      env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NEXT is not set');
  });
});
