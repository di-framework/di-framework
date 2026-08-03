import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findTopmostTsconfig, parseArgs } from '../cmd/typecheck';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

async function withExitCapture(fn: () => Promise<void>): Promise<number> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  (process as any).exit = (code: number) => {
    exitCode = code;
    throw new Error(`EXIT_${code}`);
  };
  try {
    await fn();
    throw new Error('typecheck did not exit');
  } catch (err: any) {
    if (!String(err?.message ?? err).startsWith('EXIT_')) throw err;
    return exitCode!;
  } finally {
    process.exit = originalExit;
  }
}

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
      'exits 0 against the repo root tsconfig',
      async () => {
        const { typecheck } = await import('../cmd/typecheck');
        const originalArgv = process.argv;
        const log = spyOn(console, 'log').mockImplementation(() => {});
        const err = spyOn(console, 'error').mockImplementation(() => {});
        try {
          process.chdir(REPO_ROOT);
          process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
          expect(await withExitCapture(() => typecheck())).toBe(0);
        } finally {
          process.argv = originalArgv;
          log.mockRestore();
          err.mockRestore();
        }
      },
      // Full-repo program create is slow in CI once packages like @di-framework/ai are included.
      { timeout: 60_000 },
    );

    it('exits 2 when the tsconfig path cannot be read', async () => {
      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        process.argv = ['bun', 'typecheck.ts', 'nonassigned_missing_tsconfig.json', '--pretty=0'];
        expect(await withExitCapture(() => typecheck())).toBe(2);
      } finally {
        process.argv = originalArgv;
        err.mockRestore();
      }
    });

    it('exits 2 when no tsconfig.json can be found', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'typecheck-none-'));
      temps.push(empty);
      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        process.chdir(empty);
        process.argv = ['bun', 'typecheck.ts', '--pretty=0'];
        expect(await withExitCapture(() => typecheck())).toBe(2);
        expect(err.mock.calls.some((c) => String(c[0]).includes('Could not find tsconfig'))).toBe(
          true,
        );
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
        err.mockRestore();
      }
    });

    it('exits 2 when tsconfig.json is not valid JSON', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-badjson-'));
      temps.push(dir);
      await Bun.write(join(dir, 'tsconfig.json'), '{ not json');

      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
        expect(await withExitCapture(() => typecheck())).toBe(2);
        expect(err.mock.calls.some((c) => String(c[0]).includes('Failed to parse'))).toBe(true);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
        err.mockRestore();
      }
    });

    it('exits 2 when tsconfig parsing produces diagnostics', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-cfgerr-'));
      temps.push(dir);
      // Circular extends produces config diagnostics.
      await Bun.write(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'esnext', target: 'esnext' },
          files: ['./missing-file-that-does-not-exist.ts'],
          // Invalid option value triggers parseJsonConfigFileContent errors on some TS versions;
          // pair with a bogus "extends" that cannot be resolved.
          extends: './does-not-exist.json',
        }) + '\n',
      );

      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=1'];
        expect(await withExitCapture(() => typecheck())).toBe(2);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
        err.mockRestore();
      }
    });

    it('exits 1 and prints diagnostics when sources have type errors', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-typo-'));
      temps.push(dir);
      await Bun.write(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'esnext',
            target: 'esnext',
            skipLibCheck: true,
          },
          files: ['broken.ts'],
        }) + '\n',
      );
      await Bun.write(join(dir, 'broken.ts'), 'const n: number = "not-a-number";\n');

      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        process.chdir(dir);
        // pretty=0 exercises stripAnsi; pretty=1 exercises the colored path.
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0'];
        expect(await withExitCapture(() => typecheck())).toBe(1);
        expect(err.mock.calls.some((c) => String(c[0]).includes('Typecheck failed'))).toBe(true);

        err.mockClear();
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=1'];
        expect(await withExitCapture(() => typecheck())).toBe(1);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
        err.mockRestore();
        log.mockRestore();
      }
    });

    it('prints suggestions/messages with pretty=false stripping ansi', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-msg-'));
      temps.push(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      await Bun.write(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
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
        }) + '\n',
      );
      await Bun.write(join(dir, 'src', 'ok.ts'), 'export const ok: number = 1;\n');

      const { typecheck } = await import('../cmd/typecheck');
      const originalArgv = process.argv;
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        process.chdir(dir);
        process.argv = ['bun', 'typecheck.ts', 'tsconfig.json', '--pretty=0', '--from=cwd'];
        expect(await withExitCapture(() => typecheck())).toBe(0);
        expect(log.mock.calls.some((c) => String(c[0]).includes('Typecheck passed'))).toBe(true);
      } finally {
        process.chdir(REPO_ROOT);
        process.argv = originalArgv;
        log.mockRestore();
      }
    });

    it(
      'respects --from=script when locating tsconfig',
      async () => {
        const { typecheck } = await import('../cmd/typecheck');
        const originalArgv = process.argv;
        const log = spyOn(console, 'log').mockImplementation(() => {});
        const err = spyOn(console, 'error').mockImplementation(() => {});
        try {
          process.chdir(REPO_ROOT);
          // argv[1] is the script path; --from=script walks from its directory.
          process.argv = [
            'bun',
            join(import.meta.dir, '..', 'cmd', 'typecheck.ts'),
            '--from=script',
            '--pretty=0',
          ];
          expect(await withExitCapture(() => typecheck())).toBe(0);
        } finally {
          process.argv = originalArgv;
          log.mockRestore();
          err.mockRestore();
        }
      },
      { timeout: 60_000 },
    );
  });

  describe('CLI entrypoint', () => {
    it('handleTypecheckFailure logs and exits 2', async () => {
      const { handleTypecheckFailure } = await import('../cmd/typecheck');
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handleTypecheckFailure(new Error('boom'))).toThrow('EXIT_2');
        expect(code).toBe(2);
        expect(err.mock.calls[0]?.[0]).toContain('Fatal error while running typecheck');
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('exits with code 2 when the tsconfig path cannot be read under import.meta.main', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'typecheck-main-'));
      temps.push(dir);
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '..', 'cmd', 'typecheck.ts'),
          'nope.json',
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
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, module: 'esnext', target: 'esnext' },
          files: ['typecheck-stub.ts'],
        }) + '\n',
      );
      await Bun.write(join(dir, 'typecheck-stub.ts'), 'export const ok = 1;\n');

      const preload = join(import.meta.dir, 'typecheck-stub.preload.ts');
      expect(await Bun.file(preload).exists()).toBe(true);

      const proc = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          join(import.meta.dir, '..', 'cmd', 'typecheck.ts'),
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
