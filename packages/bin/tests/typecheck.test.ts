import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'path';
import { findTopmostTsconfig, parseArgs } from '../cmd/typecheck';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('typecheck command', () => {
  describe('parseArgs', () => {
    it('parses empty args to defaults', () => {
      const args = parseArgs(['node', 'script.ts']);
      expect(typeof args.pretty).toBe('boolean');
      expect(args.from).toBe('cwd');
      expect(args.tsconfigPath).toBeUndefined();
    });

    it('parses tsconfigPath positional argument', () => {
      const args = parseArgs(['node', 'script.ts', 'custom-tsconfig.json']);
      expect(args.tsconfigPath).toBe('custom-tsconfig.json');
    });

    it('parses --pretty=1', () => {
      const args = parseArgs(['node', 'script.ts', '--pretty=1']);
      expect(args.pretty).toBe(true);
    });

    it('parses --pretty=0', () => {
      const args = parseArgs(['node', 'script.ts', '--pretty=0']);
      expect(args.pretty).toBe(false);
    });

    it('parses --from=script', () => {
      const args = parseArgs(['node', 'script.ts', '--from=script']);
      expect(args.from).toBe('script');
    });

    it('parses mixed arguments', () => {
      const args = parseArgs(['node', 'script.ts', '--pretty=0', 'foo.json', '--from=cwd']);
      expect(args.pretty).toBe(false);
      expect(args.tsconfigPath).toBe('foo.json');
      expect(args.from).toBe('cwd');
    });
  });

  describe('findTopmostTsconfig', () => {
    it('finds the repository root tsconfig from a nested directory', () => {
      // Start deep inside the packages/bin/tests dir
      const startDir = import.meta.dir;
      const result = findTopmostTsconfig(startDir);

      // The topmost tsconfig should be at the repo root
      expect(result).toBe(resolve(REPO_ROOT, 'tsconfig.json'));
    });

    it('finds the repository root tsconfig from the root itself', () => {
      const result = findTopmostTsconfig(REPO_ROOT);
      expect(result).toBe(resolve(REPO_ROOT, 'tsconfig.json'));
    });
  });
});
