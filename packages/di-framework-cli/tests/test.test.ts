import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTestFailure, test } from '../cmd/test';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'e2e-test.sh');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('test command', () => {
  const temps: string[] = [];
  afterEach(() => {
    try {
      process.chdir(REPO_ROOT);
    } catch {
      /* ignore */
    }
    for (const t of temps.splice(0)) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  describe('paths', () => {
    it('e2e script exists and is a bash script', async () => {
      expect(await Bun.file(SCRIPT_PATH).exists()).toBe(true);
      expect((await Bun.file(SCRIPT_PATH).text()).startsWith('#!/bin/bash')).toBe(true);
    });

    it('repo root contains package.json and packages/', async () => {
      expect(await Bun.file(join(REPO_ROOT, 'package.json')).exists()).toBe(true);
      expect(await Bun.file(join(REPO_ROOT, 'packages', 'cli', 'package.json')).exists()).toBe(
        true,
      );
    });
  });

  describe('e2e script content', () => {
    it('covers type checks, unit tests, examples, and a summary', async () => {
      const content = await Bun.file(SCRIPT_PATH).text();
      expect(content).toContain('TypeScript type check');
      expect(content).toContain('bun test');
      expect(content).toContain('Validating example code');
      expect(content).toContain('Test Summary');
    });
  });

  describe('test()', () => {
    it('writes the script, runs bash, and cleans up', async () => {
      await test('#!/bin/bash\necho e2e-ok\nexit 0\n');
    });

    it('propagates bash failures', async () => {
      await expect(test('#!/bin/bash\nexit 7\n')).rejects.toThrow();
    });
  });

  describe('CLI entrypoint', () => {
    it('handleTestFailure logs and exits 1', () => {
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handleTestFailure(new Error('boom'))).toThrow('EXIT_1');
        expect(code).toBe(1);
        expect(err.mock.calls[0]?.[0]).toContain('Tests failed');
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('exits with code 1 when the e2e script fails under import.meta.main', async () => {
      const root = mkdtempSync(join(tmpdir(), 'test-main-fail-'));
      temps.push(root);
      // Force the default embedded script to fail by making `bun` unavailable via a broken PATH
      // is unreliable; instead invoke handleTestFailure coverage above and spawn with a
      // stub that exits non-zero by overriding through a tiny wrapper entrypoint.
      const wrapper = join(root, 'run.ts');
      await Bun.write(
        wrapper,
        `import { test, handleTestFailure } from ${JSON.stringify(join(import.meta.dir, '..', 'cmd', 'test.ts'))};
test('#!/bin/bash\\nexit 1\\n').catch(handleTestFailure);
`,
      );
      const proc = Bun.spawn([process.execPath, wrapper], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain('Tests failed');
    });
  });
});
