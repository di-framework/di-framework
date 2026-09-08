import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMxTest, runTestMain, test } from '../cmd/mx/test';
import type { CliIo } from '../command';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'e2e-test.sh');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SILENT_IO: CliIo = { stdout: { write: () => {} }, stderr: { write: () => {} } };

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
      expect(
        await Bun.file(join(REPO_ROOT, 'packages', 'di-framework-cli', 'package.json')).exists(),
      ).toBe(true);
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
      await expect(test('#!/bin/bash\nexit 7\n')).rejects.toMatchObject({
        code: 'E2E_FAILED',
        exitCode: 1,
        details: { scriptExitCode: 7 },
      });
    });

    it('includes the script output in the failure', async () => {
      await expect(
        test('#!/bin/bash\necho boom-out\necho boom-err >&2\nexit 1\n'),
      ).rejects.toMatchObject({
        code: 'E2E_FAILED',
        message: expect.stringContaining('boom-out'),
      });
    });
  });

  describe('CLI entrypoint', () => {
    it('rejects every argument without running the suite', async () => {
      await expect(runMxTest(['--watch'], SILENT_IO)).rejects.toMatchObject({
        code: 'INVALID_USAGE',
        exitCode: 2,
      });
      expect(
        await runMxTest([], SILENT_IO, '#!/bin/bash\necho canonical-ok\nexit 0\n'),
      ).toMatchObject({ data: { passed: true, suite: 'e2e' } });
    });

    it('runTestMain uses an injected exit-code setter', async () => {
      let code: number | undefined;
      await runTestMain(
        true,
        async () => {
          throw new Error('boom');
        },
        (value) => {
          code = value;
        },
      );
      expect(code).toBe(1);
      const previousExitCode = process.exitCode;
      await runTestMain(true, async () => {
        throw new Error('default setter');
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = previousExitCode;
    });

    it('runTestMain invokes start only when isMain is true', async () => {
      let calls = 0;
      const start = async () => {
        calls++;
        return {};
      };
      await runTestMain(false, start);
      expect(calls).toBe(0);
      await runTestMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 1 when the e2e script fails under import.meta.main', async () => {
      const root = mkdtempSync(join(tmpdir(), 'test-main-fail-'));
      temps.push(root);
      const wrapper = join(root, 'run.ts');
      await Bun.write(
        wrapper,
        `import { runTestMain, test } from ${JSON.stringify(join(import.meta.dir, '..', 'cmd', 'mx', 'test.ts'))};
await runTestMain(true, async () => { await test('#!/bin/bash\\nexit 1\\n'); return {}; });
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
