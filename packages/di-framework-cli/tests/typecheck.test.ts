import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findTopmostTsconfig, parseArgs } from '../cmd/mx/typecheck';
import type { CliIo } from '../command';
import { CommandFailure } from '../command';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SILENT_IO: CliIo = { stdout: { write: () => {} }, stderr: { write: () => {} } };

async function withExitCapture(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (err) {
    if (!(err instanceof CommandFailure)) throw err;
    return err.exitCode;
  }
}

/**
 * Typechecking the whole workspace is the slowest thing in the suite and gets
 * slower with every package added, so the two tests that do it get an explicit
 * budget rather than bun's 5s default — a cold `tsc` program over the monorepo
 * runs several times longer on a CI runner than on a developer machine, and a
 * timeout there reads as a type error that nobody can reproduce locally.
 */
const FULL_TYPECHECK_TIMEOUT_MS = 120_000;

describe('typecheck command', () => {
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
      expect(parseArgs(['node', 'script.ts', '--pretty=1']).pretty).toBe(true);
    });

    it('parses --pretty=0', () => {
      expect(parseArgs(['node', 'script.ts', '--pretty=0']).pretty).toBe(false);
    });

    it('parses --from=script', () => {
      expect(parseArgs(['node', 'script.ts', '--from=script']).from).toBe('script');
    });

    it('parses mixed arguments', () => {
      const args = parseArgs(['node', 'script.ts', '--pretty=0', 'foo.json', '--from=cwd']);
      expect(args.pretty).toBe(false);
      expect(args.tsconfigPath).toBe('foo.json');
      expect(args.from).toBe('cwd');
    });

    it('strictly rejects unknown options, invalid values, and extra positionals', () => {
      expect(() => parseArgs(['node', 'script.ts', '--watch'])).toThrow('Unknown mx typecheck');
      expect(() => parseArgs(['node', 'script.ts', '--pretty=yes'])).toThrow(
        'Invalid --pretty value',
      );
      expect(() => parseArgs(['node', 'script.ts', '--from=elsewhere'])).toThrow(
        'Invalid --from value',
      );
      expect(() => parseArgs(['node', 'script.ts', 'one.json', 'two.json'])).toThrow(
        'Unexpected mx typecheck argument',
      );
    });
  });

  describe('findTopmostTsconfig', () => {
    it('finds the repository root tsconfig from a nested directory', () => {
      expect(findTopmostTsconfig(import.meta.dir)).toBe(resolve(REPO_ROOT, 'tsconfig.json'));
    });

    it('finds the repository root tsconfig from the root itself', () => {
      expect(findTopmostTsconfig(REPO_ROOT)).toBe(resolve(REPO_ROOT, 'tsconfig.json'));
    });

    it('returns undefined when no tsconfig exists above the start dir', () => {
      const empty = mkdtempSync(join(tmpdir(), 'no-tsconfig-'));
      temps.push(empty);
      // Isolate from repo by using a path that won't walk into the workspace.
      // On typical setups /tmp has no tsconfig.json up to /.
      expect(findTopmostTsconfig(empty)).toBeUndefined();
    });
  });

  describe('typecheck()', () => {
    it(
      'exits 0 against a minimal project tsconfig',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'typecheck-ok-root-'));
        temps.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        await Bun.write(
          join(dir, 'tsconfig.json'),
          `${JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: 'esnext',
              target: 'esnext',
              skipLibCheck: true,
            },
            files: ['src/ok.ts'],
          })}\n`,
        );
        await Bun.write(join(dir, 'src', 'ok.ts'), 'export const ok: number = 1;\n');

        const { typecheck } = await import('../cmd/mx/typecheck');
        const originalArgv = process.argv;
        try {
          process.chdir(dir);
          process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
          expect(await withExitCapture(() => typecheck(process.argv, SILENT_IO))).toBe(0);
        } finally {
          process.chdir(REPO_ROOT);
          process.argv = originalArgv;
        }
      },
      FULL_TYPECHECK_TIMEOUT_MS,
    );

    it('exits 2 when the tsconfig path cannot be read', async () => {
      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      try {
        process.argv = ['bun', 'typecheck.ts', 'nonassigned_missing_tsconfig.json', '--pretty=0'];
        expect(await withExitCapture(() => typecheck(process.argv, SILENT_IO))).toBe(2);
      } finally {
        process.argv = originalArgv;
      }
    });

    it('exits 2 when no tsconfig.json can be found', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'typecheck-none-'));
      temps.push(empty);
      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      try {
        process.chdir(empty);
        process.argv = ['bun', 'typecheck.ts', '--pretty=0'];
        await expect(typecheck(process.argv, SILENT_IO)).rejects.toMatchObject({
          code: 'INVALID_CONFIG',
          exitCode: 2,
        });
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
      }
    });

    it('exits 2 when tsconfig.json is not valid JSON', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-badjson-'));
      temps.push(dir);
      await Bun.write(join(dir, 'tsconfig.json'), '{ not json');

      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
        await expect(typecheck(process.argv, SILENT_IO)).rejects.toMatchObject({
          code: 'INVALID_CONFIG',
          exitCode: 2,
        });
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
      }
    });

    it('exits 2 when tsconfig parsing produces diagnostics', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-cfgerr-'));
      temps.push(dir);
      // Circular extends produces config diagnostics.
      await Bun.write(
        join(dir, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: { module: 'esnext', target: 'esnext' },
          files: ['./missing-file-that-does-not-exist.ts'],
          // Invalid option value triggers parseJsonConfigFileContent errors on some TS versions;
          // pair with a bogus "extends" that cannot be resolved.
          extends: './does-not-exist.json',
        })}\n`,
      );

      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=1'];
        expect(await withExitCapture(() => typecheck(process.argv, SILENT_IO))).toBe(2);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
      }
    });

    it('exits 1 and prints diagnostics when sources have type errors', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-typo-'));
      temps.push(dir);
      await Bun.write(
        join(dir, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'esnext',
            target: 'esnext',
            skipLibCheck: true,
          },
          files: ['broken.ts'],
        })}\n`,
      );
      await Bun.write(join(dir, 'broken.ts'), 'const n: number = "not-a-number";\n');

      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      const stderr: string[] = [];
      const io: CliIo = {
        stdout: { write: () => {} },
        stderr: { write: (chunk) => stderr.push(chunk) },
      };
      try {
        process.chdir(dir);
        // pretty=0 exercises stripAnsi; pretty=1 exercises the colored path.
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
        expect(await withExitCapture(() => typecheck(process.argv, io))).toBe(1);
        expect(stderr.join('')).toContain('not assignable');

        stderr.length = 0;
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=1'];
        expect(await withExitCapture(() => typecheck(process.argv, io))).toBe(1);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
      }
    });

    it('prints suggestions/messages with pretty=false stripping ansi', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-msg-'));
      temps.push(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      await Bun.write(
        join(dir, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'esnext',
            target: 'esnext',
            skipLibCheck: true,
            // Produce a non-error diagnostic category when possible via unused locals as warning
            // — TS reports unused as error under noUnusedLocals; use a plain success + force
            // message via an invalid triple-slash that yields Message category is hard.
            // Instead: include a file that typechecks cleanly so we hit the success banner,
            // and a separate run covers errors. Here we just ensure pretty path works.
            noUnusedLocals: false,
          },
          files: ['src/ok.ts'],
        })}\n`,
      );
      await Bun.write(join(dir, 'src', 'ok.ts'), 'export const ok: number = 1;\n');

      const { typecheck } = await import('../cmd/mx/typecheck');
      const originalArgv = process.argv;
      const stdout: string[] = [];
      const io: CliIo = {
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => {} },
      };
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0', '--from=cwd'];
        const result = await typecheck(process.argv, io);
        expect(result.data).toMatchObject({ errors: 0, warnings: 0 });
        expect((result.data as { files: number }).files).toBeGreaterThan(0);
        expect(stdout.join('')).toContain('Using tsconfig');
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
      }
    });

    it(
      'respects --from=script when locating tsconfig',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'typecheck-from-script-'));
        temps.push(dir);
        mkdirSync(join(dir, 'nested'), { recursive: true });
        await Bun.write(
          join(dir, 'tsconfig.json'),
          `${JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: 'esnext',
              target: 'esnext',
              skipLibCheck: true,
            },
            files: ['ok.ts'],
          })}\n`,
        );
        await Bun.write(join(dir, 'ok.ts'), 'export const ok: number = 1;\n');
        // Fake script path under dir so --from=script walks up to dir/tsconfig.json.
        const fakeScript = join(dir, 'nested', 'typecheck.ts');
        await Bun.write(fakeScript, '// placeholder\n');

        const { typecheck } = await import('../cmd/mx/typecheck');
        const originalArgv = process.argv;
        try {
          process.chdir(join(dir, 'nested'));
          process.argv = ['bun', fakeScript, '--from=script', '--pretty=0'];
          expect(await withExitCapture(() => typecheck(process.argv, SILENT_IO))).toBe(0);
        } finally {
          process.chdir(REPO_ROOT);
          process.argv = originalArgv;
        }
      },
      FULL_TYPECHECK_TIMEOUT_MS,
    );
  });

  describe('CLI entrypoint', () => {
    it('runTypecheckMain uses typed and fallback exit codes', async () => {
      const { runTypecheckMain } = await import('../cmd/mx/typecheck');
      let code: number | undefined;
      await runTypecheckMain(
        true,
        async () => {
          throw new Error('boom');
        },
        (value) => {
          code = value;
        },
      );
      expect(code).toBe(2);
      await runTypecheckMain(
        true,
        async () => {
          throw new CommandFailure('TYPECHECK_FAILED', 'typed failure', 1);
        },
        (value) => {
          code = value;
        },
      );
      expect(code).toBe(1);
      const previousExitCode = process.exitCode;
      await runTypecheckMain(true, async () => {
        throw new Error('default setter');
      });
      expect(process.exitCode).toBe(2);
      process.exitCode = previousExitCode;
    });

    it('runTypecheckMain invokes start only when isMain is true', async () => {
      const { runTypecheckMain } = await import('../cmd/mx/typecheck');
      let calls = 0;
      const start = async () => {
        calls++;
        return {};
      };
      await runTypecheckMain(false, start);
      expect(calls).toBe(0);
      await runTypecheckMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 2 when the tsconfig path cannot be read under import.meta.main', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-main-'));
      temps.push(dir);
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '..', 'cmd', 'mx', 'typecheck.ts'),
          'noop.json',
          '--pretty=0',
        ],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await proc.exited).toBe(2);
    });

    it('exits with code 2 when typecheck throws unexpectedly under import.meta.main', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-fatal-'));
      temps.push(dir);
      await Bun.write(
        join(dir, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, module: 'esnext', target: 'esnext' },
          files: ['typecheck-stub.ts'],
        })}\n`,
      );
      await Bun.write(join(dir, 'typecheck-stub.ts'), 'export const ok = 1;\n');

      const preload = join(import.meta.dir, 'typecheck-stub.preload.ts');
      expect(await Bun.file(preload).exists()).toBe(true);

      const proc = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          join(import.meta.dir, '..', 'cmd', 'mx', 'typecheck.ts'),
          join(dir, 'tsconfig.json'),
          '--pretty=0',
        ],
        {
          cwd: REPO_ROOT,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(stderr).not.toContain('preload not found');
      expect(stderr).toContain('Fatal error while running typecheck');
      expect(code).toBe(2);
    });
  });
});
