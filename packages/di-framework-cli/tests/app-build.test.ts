import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, buildApp, handleBuildFailure, parseBuildArgs, runBuildMain } from '../cmd/build';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('app build command', () => {
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

  it('parseBuildArgs resolves cwd', () => {
    const opts = parseBuildArgs([], '/tmp');
    expect(opts.cwd).toBe('/tmp');
  });

  it('fails without package.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-'));
    temps.push(root);
    await expect(buildApp({ cwd: root, passthrough: [] })).rejects.toThrow('No package.json');
  });

  it('runs package.json build script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-script-'));
    temps.push(root);
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { build: 'mkdir -p dist && echo ok > dist/out.txt' },
      }) + '\n',
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await buildApp({ cwd: root, passthrough: [] });
      expect(await Bun.file(join(root, 'dist', 'out.txt')).text()).toContain('ok');
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('falls back to tsc when no build script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-tsc-'));
    temps.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
    await Bun.write(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          outDir: 'dist',
          rootDir: 'src',
          module: 'esnext',
          target: 'esnext',
          skipLibCheck: true,
          noEmit: false,
        },
        include: ['src/**/*.ts'],
      }) + '\n',
    );
    await Bun.write(join(root, 'src', 'index.ts'), 'export const n = 1;\n');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await buildApp({ cwd: root, passthrough: [] });
      expect(await Bun.file(join(root, 'dist', 'index.js')).exists()).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 60_000);

  it('handleBuildFailure exits 1', () => {
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
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('runBuildMain respects isMain', () => {
    let calls = 0;
    runBuildMain(false, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    runBuildMain(true, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it('build --help prints help', async () => {
    await build(['--help']);
    await build(['-h']);
  });

  it('buildApp honors --help in passthrough', async () => {
    await buildApp({ cwd: '/tmp', passthrough: ['--help'] });
    await buildApp({ cwd: '/tmp', passthrough: ['-h'] });
  });

  it('throws when package.json has neither build script nor tsconfig', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-empty-'));
    temps.push(root);
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
    await expect(buildApp({ cwd: root, passthrough: [] })).rejects.toThrow('Nothing to build');
  });

  it('detects pnpm, yarn, and npm via lockfiles and runs matching installers', async () => {
    const { detectPackageManager } = await import('../cmd/build');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const seen: string[] = [];
    const fakeShell = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
      const cmd = strings.reduce((acc, s, i) => acc + s + (exprs[i] ?? ''), '');
      seen.push(cmd);
      return {
        cwd: () => Promise.resolve(),
      };
    }) as unknown as import('../cmd/build').BuildShell;

    try {
      for (const [lock, expectedPm, needle] of [
        ['pnpm-lock.yaml', 'pnpm', 'pnpm run build'],
        ['yarn.lock', 'yarn', 'yarn run build'],
        ['package-lock.json', 'npm', 'npm run build'],
      ] as const) {
        const root = mkdtempSync(join(tmpdir(), `app-build-${lock}-`));
        temps.push(root);
        await Bun.write(join(root, lock), '# lock\n');
        await Bun.write(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'x',
            scripts: { build: 'echo ok' },
          }) + '\n',
        );
        expect(detectPackageManager(root)).toBe(expectedPm);
        await buildApp({ cwd: root, passthrough: [] }, fakeShell);
        expect(seen.some((c) => c.includes(needle))).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('build without flags runs buildApp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-default-'));
    temps.push(root);
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { build: 'mkdir -p dist && echo ok > dist/out.txt' },
      }) + '\n',
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await build([]);
      expect(await Bun.file(join(root, 'dist', 'out.txt')).text()).toContain('ok');
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  }, 30_000);
});
