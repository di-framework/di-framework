import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, buildApp, handleBuildFailure, parseBuildArgs, runBuildMain } from '../cmd/build';
import type { CliIo } from '../command';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

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

  it('ignores package.json build script and runs tsc', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-ignore-script-'));
    temps.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { build: 'echo should-not-run && exit 1' },
      }) + '\n',
    );
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

  it('runs tsc when no ttsc', async () => {
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

  it('runs ttsc --emit when ttsc is declared', async () => {
    const { hasTtsc } = await import('../cmd/build');
    const root = mkdtempSync(join(tmpdir(), 'app-build-ttsc-'));
    temps.push(root);
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        devDependencies: { ttsc: '>=0.25.0' },
      }) + '\n',
    );
    await Bun.write(join(root, 'tsconfig.json'), '{}\n');
    expect(hasTtsc(root, { devDependencies: { ttsc: '>=0.25.0' } })).toBe(true);

    const seen: string[] = [];
    const fakeShell = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
      const cmd = strings.reduce((acc, s, i) => acc + s + (exprs[i] ?? ''), '');
      seen.push(cmd);
      return {
        cwd: () => Promise.resolve(),
      };
    }) as unknown as import('../cmd/build').BuildShell;

    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await buildApp({ cwd: root, passthrough: [] }, fakeShell);
      expect(seen.some((c) => c.includes('ttsc') && c.includes('--emit'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('treats @di-framework/tsc as implying ttsc', async () => {
    const { hasTtsc } = await import('../cmd/build');
    expect(hasTtsc('/tmp', { devDependencies: { '@di-framework/tsc': 'latest' } })).toBe(true);
  });

  it('hasTtsc detects node_modules/ttsc', async () => {
    const { hasTtsc } = await import('../cmd/build');
    const root = mkdtempSync(join(tmpdir(), 'app-build-ttsc-nm-'));
    temps.push(root);
    mkdirSync(join(root, 'node_modules', 'ttsc'), { recursive: true });
    expect(hasTtsc(root)).toBe(true);
    expect(hasTtsc(root, {})).toBe(true);
  });

  it('handleBuildFailure assigns exit code 1 without exiting', () => {
    const captured = captureIo();
    let code: number | undefined;
    handleBuildFailure(new Error('boom'), captured.io, (value) => {
      code = value;
    });
    expect(code).toBe(1);
    expect(captured.stderr.join('')).toContain('build failed: boom');
    const previousExitCode = process.exitCode;
    handleBuildFailure('default setter', captured.io);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
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

  it('throws when package.json has no tsconfig', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-empty-'));
    temps.push(root);
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
    await expect(buildApp({ cwd: root, passthrough: [] })).rejects.toThrow('Nothing to build');
  });

  it('detectPackageManager reads lockfiles', async () => {
    const { detectPackageManager } = await import('../cmd/build');
    for (const [lock, expectedPm] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['bun.lock', 'bun'],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `app-build-${lock}-`));
      temps.push(root);
      await Bun.write(join(root, lock), '# lock\n');
      expect(detectPackageManager(root)).toBe(expectedPm);
    }
  });

  it('build without flags runs buildApp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-build-default-'));
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
      await build([], root);
      expect(await Bun.file(join(root, 'dist', 'index.js')).exists()).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
