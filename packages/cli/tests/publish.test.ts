import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PACKAGES } from '../cmd/publish';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('publish command', () => {
  describe('PACKAGES', () => {
    it('includes all expected packages', () => {
      expect(PACKAGES).toContain('packages/di-framework');
      expect(PACKAGES).toContain('packages/di-framework-repo');
      expect(PACKAGES).toContain('packages/di-framework-http');
      expect(PACKAGES).toContain('packages/cli');
    });

    it('matches the build command PACKAGES list', async () => {
      const { PACKAGES: BUILD_PACKAGES } = await import('../cmd/build');
      expect(PACKAGES).toEqual(BUILD_PACKAGES);
    });

    it('every package directory exists', () => {
      for (const pkg of PACKAGES) {
        expect(existsSync(join(REPO_ROOT, pkg))).toBe(true);
      }
    });
  });

  describe('package metadata', () => {
    it('every package has a name', () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf-8'));
        expect(pkgJson.name).toBeDefined();
        expect(typeof pkgJson.name).toBe('string');
        expect(pkgJson.name.length).toBeGreaterThan(0);
      }
    });

    it('every package has a version', () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf-8'));
        expect(pkgJson.version).toBeDefined();
        expect(typeof pkgJson.version).toBe('string');
      }
    });

    it('no package is marked as private (publishable)', () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf-8'));
        expect(pkgJson.private).not.toBe(true);
      }
    });

    it('scoped packages use the @di-framework scope', () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf-8'));
        if (pkgJson.name.startsWith('@')) {
          expect(pkgJson.name).toMatch(/^@di-framework\//);
        }
      }
    });

    it('every package has a repository.url for npm provenance', () => {
      for (const pkg of PACKAGES) {
        const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf-8'));
        expect(pkgJson.repository).toBeDefined();
        expect(typeof pkgJson.repository).toBe('object');
        expect(pkgJson.repository.url).toBe('https://github.com/di-framework/di-framework');
      }
    });
  });

  describe('publish pipeline order', () => {
    it('runs tests before build in the source', () => {
      const source = readFileSync(join(import.meta.dir, '..', 'cmd', 'publish.ts'), 'utf-8');
      const testIndex = source.indexOf('bun test');
      const buildIndex = source.indexOf('bun run packages/bin/cmd/build.ts');
      const publishIndex = source.indexOf('bun publish');

      expect(testIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(-1);
      expect(publishIndex).toBeGreaterThan(-1);
      expect(testIndex).toBeLessThan(buildIndex);
      expect(buildIndex).toBeLessThan(publishIndex);
    });
  });
});
