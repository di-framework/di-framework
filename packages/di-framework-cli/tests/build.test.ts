import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGES } from '../cmd/mx/build';
import type { CliIo } from '../command';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function captureIo(): { io: CliIo; stderr: string[]; stdout: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
    stderr,
    stdout,
  };
}

async function makeFakeWorkspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'build-cmd-'));
  await Bun.write(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'root', version: '9.9.9' })}\n`,
  );

  for (const pkgDir of PACKAGES) {
    const full = join(root, pkgDir);
    mkdirSync(full, { recursive: true });
    await Bun.write(
      join(full, 'package.json'),
      `${JSON.stringify({
        name: `@test/${pkgDir.split('/').pop()}`,
        version: '0.0.0',
        scripts: { build: 'mkdir -p dist && echo ok > dist/out.txt' },
      })}\n`,
    );
  }

  // Exercise the tsconfig.build.json branch on the first package.
  const first = join(root, PACKAGES[0]!);
  await Bun.write(
    join(first, 'tsconfig.build.json'),
    `${JSON.stringify({
      compilerOptions: {
        outDir: 'dist',
        rootDir: 'src',
        declaration: false,
        module: 'esnext',
        target: 'esnext',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    })}\n`,
  );
  await Bun.write(join(first, 'src', 'index.ts'), 'export const x = 1;\n');
  // Drop the build script so only the tsc path is used for this package.
  const pkgJson = JSON.parse(await Bun.file(join(first, 'package.json')).text());
  delete pkgJson.scripts;
  await Bun.write(join(first, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`);

  return root;
}

describe('build command', () => {
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

  describe('parseMxBuildArgs', () => {
    it('defaults to no version sync', async () => {
      const { parseMxBuildArgs } = await import('../cmd/mx/build');
      expect(parseMxBuildArgs([])).toEqual({ syncVersions: false });
      expect(() => parseMxBuildArgs(['--watch'])).toThrow('Unknown mx build argument');
    });

    it('enables version sync for --sync-versions', async () => {
      const { parseMxBuildArgs } = await import('../cmd/mx/build');
      expect(parseMxBuildArgs(['--sync-versions'])).toEqual({ syncVersions: true });
      expect(() => parseMxBuildArgs(['--sync-versions', '--sync-versions'])).toThrow(
        'Duplicate mx build argument',
      );
    });
  });

  describe('PACKAGES', () => {
    it('includes all expected packages', () => {
      expect(PACKAGES).toContain('packages/di-framework-core');
      expect(PACKAGES).toContain('packages/di-framework-repo');
      expect(PACKAGES).toContain('packages/di-framework-http');
      expect(PACKAGES).toContain('packages/di-framework-graphql');
      expect(PACKAGES).toContain('packages/di-framework-events');
      expect(PACKAGES).toContain('packages/di-framework-config');
      expect(PACKAGES).toContain('packages/di-framework-auth');
      expect(PACKAGES).toContain('packages/di-framework-authz');
      expect(PACKAGES).toContain('packages/di-framework-socket');
      expect(PACKAGES).toContain('packages/di-framework-rpc');
      expect(PACKAGES).toContain('packages/di-framework-ai');
      expect(PACKAGES).toContain('packages/di-framework-ai-utils');
      expect(PACKAGES).toContain('packages/di-framework-codegen');
      expect(PACKAGES).toContain('packages/di-framework-cloudfoundry');
      expect(PACKAGES).toContain('packages/di-framework-wasmcloud');
      expect(PACKAGES).toContain('packages/di-framework-cli-extension');
      expect(PACKAGES).toContain('packages/di-framework-cli-plugin-wasmcloud');
      expect(PACKAGES).toContain('packages/di-framework-cli');
      expect(PACKAGES).toContain('packages/di-framework-tsc');
    });

    it('every package directory exists', async () => {
      for (const pkg of PACKAGES) {
        expect(await Bun.file(join(REPO_ROOT, pkg, 'package.json')).exists()).toBe(true);
      }
    });

    it('every package has a package.json', async () => {
      for (const pkg of PACKAGES) {
        expect(await Bun.file(join(REPO_ROOT, pkg, 'package.json')).exists()).toBe(true);
      }
    });
  });

  describe('build()', () => {
    it('formats shell output and wraps package build failures', async () => {
      const { buildFailure, shellText } = await import('../cmd/mx/build');
      expect(shellText('plain')).toBe('plain');
      expect(shellText(new TextEncoder().encode('bytes'))).toBe('bytes');
      expect(shellText(undefined)).toBe('');

      const fromStderr = buildFailure('packages/demo', { stderr: 'tsc failed\n' });
      expect(fromStderr).toMatchObject({
        code: 'BUILD_FAILED',
        exitCode: 1,
        details: { package: 'packages/demo', cause: 'tsc failed' },
      });
      expect(fromStderr.message).toContain('packages/demo');
      expect(fromStderr.message).toContain('tsc failed');

      const fromStdout = buildFailure('packages/demo', { stdout: Buffer.from('compiled? no\n') });
      expect(fromStdout.details).toMatchObject({ cause: 'compiled? no' });

      const fromError = buildFailure('packages/demo', new Error('boom'));
      expect(fromError.details).toMatchObject({ cause: 'boom' });

      const fromValue = buildFailure('packages/demo', 7);
      expect(fromValue.details).toMatchObject({ cause: '7' });
    });

    it('wraps a failing package build with BUILD_FAILED', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      const failing = join(root, PACKAGES[1]!);
      await Bun.write(
        join(failing, 'package.json'),
        `${JSON.stringify({
          name: '@test/failing',
          version: '0.0.0',
          scripts: { build: 'echo build-went-wrong >&2 && exit 2' },
        })}\n`,
      );

      const { build } = await import('../cmd/mx/build');
      await expect(build({ workspaceRoot: root }, captureIo().io)).rejects.toMatchObject({
        code: 'BUILD_FAILED',
        exitCode: 1,
      });
    }, 30_000);

    it('cleans stale tsc incremental caches so dist is re-emitted', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      const first = join(root, PACKAGES[0]!);
      mkdirSync(join(first, 'dist'), { recursive: true });
      await Bun.write(join(first, 'dist', 'stale.txt'), 'gone');
      await Bun.write(join(first, 'tsconfig.build.tsbuildinfo'), 'stale-cache');
      await Bun.write(join(first, 'tsconfig.tsbuildinfo'), 'stale-cache');

      const { build } = await import('../cmd/mx/build');
      await build({ workspaceRoot: root }, captureIo().io);

      expect(await Bun.file(join(first, 'tsconfig.build.tsbuildinfo')).exists()).toBe(false);
      expect(await Bun.file(join(first, 'tsconfig.tsbuildinfo')).exists()).toBe(false);
      expect(await Bun.file(join(first, 'dist', 'stale.txt')).exists()).toBe(false);
      expect(await Bun.file(join(first, 'dist', 'index.js')).exists()).toBe(true);
    }, 30_000);

    it('cleans dist and builds each package without rewriting versions', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      const output = captureIo();

      const { build } = await import('../cmd/mx/build');
      await build({ workspaceRoot: root }, output.io);

      for (const pkgDir of PACKAGES) {
        const pkgJson = JSON.parse(await Bun.file(join(root, pkgDir, 'package.json')).text());
        expect(pkgJson.version).toBe('0.0.0');
      }
      expect(await Bun.file(join(root, PACKAGES[0]!, 'dist', 'index.js')).exists()).toBe(true);
      expect(output.stdout.join('')).not.toContain('Using version');
    }, 30_000);

    it('syncs versions when --sync-versions is set', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      const output = captureIo();

      const { build } = await import('../cmd/mx/build');
      await build({ syncVersions: true, workspaceRoot: root }, output.io);

      for (const pkgDir of PACKAGES) {
        const pkgJson = JSON.parse(await Bun.file(join(root, pkgDir, 'package.json')).text());
        expect(pkgJson.version).toBe('9.9.9');
      }
      expect(await Bun.file(join(root, PACKAGES[0]!, 'dist', 'index.js')).exists()).toBe(true);
      expect(output.stdout.join('')).toContain('Using version 9.9.9');
    }, 30_000);

    it('skips version sync when a package.json is missing', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      rmSync(join(root, PACKAGES[1]!, 'package.json'));

      await Bun.write(
        join(root, PACKAGES[1]!, 'tsconfig.build.json'),
        `${JSON.stringify({
          compilerOptions: {
            outDir: 'dist',
            rootDir: 'src',
            module: 'esnext',
            target: 'esnext',
            skipLibCheck: true,
          },
          include: ['src/**/*.ts'],
        })}\n`,
      );
      await Bun.write(join(root, PACKAGES[1]!, 'src', 'index.ts'), 'export const y = 2;\n');

      const { build } = await import('../cmd/mx/build');
      await build({ syncVersions: true, workspaceRoot: root }, captureIo().io);
      expect(await Bun.file(join(root, PACKAGES[1]!, 'package.json')).exists()).toBe(false);
      expect(await Bun.file(join(root, PACKAGES[1]!, 'dist', 'index.js')).exists()).toBe(true);
    }, 30_000);

    it('rethrows non-ENOENT errors while syncing versions', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      await Bun.write(join(root, PACKAGES[1]!, 'package.json'), '{');

      const { build } = await import('../cmd/mx/build');
      await expect(
        build({ syncVersions: true, workspaceRoot: root }, captureIo().io),
      ).rejects.toThrow();
    }, 30_000);
  });

  describe('CLI entrypoint', () => {
    it('runMxBuild rejects unsupported arguments before writing output', async () => {
      const { runMxBuild } = await import('../cmd/mx/build');
      const output = captureIo();
      await expect(runMxBuild(['--watch'], output.io)).rejects.toMatchObject({
        code: 'INVALID_USAGE',
        exitCode: 2,
      });
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([]);
    });

    it('runBuildMain uses an injected exit-code setter', async () => {
      const { runBuildMain } = await import('../cmd/mx/build');
      let code: number | undefined;
      await runBuildMain(
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
      await runBuildMain(true, async () => {
        throw new Error('default setter');
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = previousExitCode;
    });

    it('runBuildMain invokes start only when isMain is true', async () => {
      const { runBuildMain } = await import('../cmd/mx/build');
      let calls = 0;
      const start = async () => {
        calls++;
        return {};
      };
      await runBuildMain(false, start);
      expect(calls).toBe(0);
      await runBuildMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 1 when build fails under import.meta.main', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'build-main-fail-'));
      temps.push(empty);
      await Bun.write(join(empty, 'package.json'), '{'); // invalid JSON → build throws

      const proc = Bun.spawn(
        ['bun', join(import.meta.dir, '..', 'cmd', 'mx', 'build.ts'), '--sync-versions'],
        {
          cwd: empty,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain('Build failed');
    });
  });
});
