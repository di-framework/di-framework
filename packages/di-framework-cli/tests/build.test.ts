import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGES } from '../cmd/mx/build';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

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
  // @ts-expect-error - Property 'json' does not exist on type 'BunFile'.
  const pkgJson = await Bun.file(join(first, 'package.json')).json();
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
    it('syncs versions, cleans dist, and builds each package', async () => {
      const root = await makeFakeWorkspace();
      temps.push(root);
      const log = spyOn(console, 'log').mockImplementation(() => {});

      try {
        process.chdir(root);
        const { build } = await import('../cmd/mx/build');
        await build();

        for (const pkgDir of PACKAGES) {
          // @ts-expect-error - Property 'json' does not exist on type 'BunFile'.
          const pkgJson = await Bun.file(join(root, pkgDir, 'package.json')).json();
          expect(pkgJson.version).toBe('9.9.9');
        }
        expect(await Bun.file(join(root, PACKAGES[0]!, 'dist', 'index.js')).exists()).toBe(true);
      } finally {
        process.chdir(REPO_ROOT);
        log.mockRestore();
      }
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

      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        process.chdir(root);
        const { build } = await import('../cmd/mx/build');
        await build();
        expect(await Bun.file(join(root, PACKAGES[1]!, 'package.json')).exists()).toBe(false);
        expect(await Bun.file(join(root, PACKAGES[1]!, 'dist', 'index.js')).exists()).toBe(true);
      } finally {
        process.chdir(REPO_ROOT);
        log.mockRestore();
      }
    }, 30_000);
  });

  describe('CLI entrypoint', () => {
    it('handleBuildFailure logs and exits 1', async () => {
      const { handleBuildFailure } = await import('../cmd/mx/build');
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handleBuildFailure(new Error('boom'))).toThrow('EXIT_1');
        expect(code).toBe(1);
        expect(err.mock.calls[0]?.[0]).toContain('Build failed');
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('runBuildMain invokes start only when isMain is true', async () => {
      const { runBuildMain } = await import('../cmd/mx/build');
      let calls = 0;
      const start = async () => {
        calls++;
      };
      runBuildMain(false, start);
      expect(calls).toBe(0);
      runBuildMain(true, start);
      expect(calls).toBe(1);
    });

    it('exits with code 1 when build fails under import.meta.main', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'build-main-fail-'));
      temps.push(empty);
      await Bun.write(join(empty, 'package.json'), '{'); // invalid JSON → build throws

      const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'cmd', 'mx', 'build.ts')], {
        cwd: empty,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain('Build failed');
    });
  });
});
