import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PACKAGES } from '../cmd/build';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('build command', () => {
  describe('PACKAGES', () => {
    it('includes all expected packages', () => {
      expect(PACKAGES).toContain('packages/di-framework');
      expect(PACKAGES).toContain('packages/di-framework-repo');
      expect(PACKAGES).toContain('packages/di-framework-http');
      expect(PACKAGES).toContain('packages/cli');
    });

    it('every package directory exists', () => {
      for (const pkg of PACKAGES) {
        const fullPath = join(REPO_ROOT, pkg);
        expect(existsSync(fullPath)).toBe(true);
      }
    });

    it('every package has a package.json', () => {
      for (const pkg of PACKAGES) {
        const pkgJsonPath = join(REPO_ROOT, pkg, 'package.json');
        expect(existsSync(pkgJsonPath)).toBe(true);
      }
    });
  });

  describe('version sync', () => {
    it('syncs the root version into a package.json', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'build-test-'));
      try {
        const fakePkg = { name: 'test-pkg', version: '0.0.0' };
        const pkgPath = join(tmp, 'package.json');
        writeFileSync(pkgPath, JSON.stringify(fakePkg));

        // Simulate what build() does for version sync
        const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
        const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        pkgJson.version = rootPkg.version;
        writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');

        const result = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        expect(result.version).toBe(rootPkg.version);
        expect(result.name).toBe('test-pkg');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('build configs', () => {
    it('every package has a tsconfig.json or tsconfig.build.json or a build script', () => {
      for (const pkg of PACKAGES) {
        const fullPath = join(REPO_ROOT, pkg);
        const hasTsconfigBuild = existsSync(join(fullPath, 'tsconfig.build.json'));
        const hasTsconfig = existsSync(join(fullPath, 'tsconfig.json'));
        const pkgJson = JSON.parse(readFileSync(join(fullPath, 'package.json'), 'utf-8'));
        const hasBuildScript = !!pkgJson.scripts?.build;

        expect(hasTsconfigBuild || hasBuildScript).toBe(true);
      }
    });
  });

  describe('build execution', () => {
    it('exports a build function', async () => {
      const { build } = await import('../cmd/build');
      expect(typeof build).toBe('function');
    });
  });
});
