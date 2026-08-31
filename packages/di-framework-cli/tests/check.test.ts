import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  checkApp,
  findNearestTsconfig,
  handleCheckFailure,
  parseCheckArgs,
  runCheckMain,
} from '../cmd/check';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('check command', () => {
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

  describe('findNearestTsconfig', () => {
    it('finds tsconfig in the start directory', () => {
      const root = mkdtempSync(join(tmpdir(), 'check-near-'));
      temps.push(root);
      writeFileSync(join(root, 'tsconfig.json'), '{}\n');
      expect(findNearestTsconfig(root)).toBe(join(root, 'tsconfig.json'));
    });

    it('walks up until found', () => {
      const root = mkdtempSync(join(tmpdir(), 'check-up-'));
      temps.push(root);
      writeFileSync(join(root, 'tsconfig.json'), '{}\n');
      const nested = join(root, 'a', 'b');
      mkdirSync(nested, { recursive: true });
      expect(findNearestTsconfig(nested)).toBe(join(root, 'tsconfig.json'));
    });
  });

  describe('parseCheckArgs', () => {
    it('parses path and pretty flags', () => {
      const opts = parseCheckArgs(['./tsconfig.build.json', '--pretty=0'], '/tmp');
      expect(opts.tsconfigPath).toBe('./tsconfig.build.json');
      expect(opts.pretty).toBe(false);
      expect(opts.cwd).toBe('/tmp');
    });

    it('parses --pretty and --no-pretty', () => {
      expect(parseCheckArgs(['--pretty'], '/tmp').pretty).toBe(true);
      expect(parseCheckArgs(['--no-pretty'], '/tmp').pretty).toBe(false);
    });
  });

  describe('checkApp', () => {
    it('passes a valid project', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-ok-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await checkApp({ cwd: root, pretty: false });
      } finally {
        log.mockRestore();
      }
    }, 60_000);

    it('fails without tsconfig', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-none-'));
      temps.push(root);
      await expect(checkApp({ cwd: root, pretty: false })).rejects.toThrow('tsconfig');
    });

    it('ignores package.json check script and runs tsc', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-ignore-script-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'x',
          scripts: { check: 'echo should-not-run && exit 1' },
        }) + '\n',
      );
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await checkApp({ cwd: root, pretty: false });
      } finally {
        log.mockRestore();
      }
    }, 60_000);

    it('runs tsc when package.json has no ttsc', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-no-ttsc-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await checkApp({ cwd: root, pretty: false });
      } finally {
        log.mockRestore();
      }
    }, 60_000);

    it('prefers ttsc --noEmit when ttsc is installed locally', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-ttsc-'));
      temps.push(root);
      mkdirSync(join(root, 'node_modules', 'ttsc'), { recursive: true });
      await Bun.write(
        join(root, 'node_modules', 'ttsc', 'package.json'),
        JSON.stringify({
          name: 'ttsc',
          version: '0.0.0',
          bin: { ttsc: './cli.js' },
        }) + '\n',
      );
      await Bun.write(
        join(root, 'node_modules', 'ttsc', 'cli.js'),
        '#!/usr/bin/env node\nprocess.exit(0);\n',
      );
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      await Bun.write(
        join(root, 'node_modules', '.bin', 'ttsc'),
        `#!/usr/bin/env bash\nexec node "${join(root, 'node_modules', 'ttsc', 'cli.js')}" "$@"\n`,
      );
      await Bun.$`chmod +x ${join(root, 'node_modules', '.bin', 'ttsc')} ${join(root, 'node_modules', 'ttsc', 'cli.js')}`;
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
      await Bun.write(join(root, 'tsconfig.json'), '{}\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await checkApp({ cwd: root, pretty: false });
        expect(log.mock.calls.some((c) => String(c[0]).includes('ttsc'))).toBe(true);
      } finally {
        log.mockRestore();
      }
    }, 30_000);

    it('honors an explicit tsconfig path', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-explicit-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'x' }) + '\n');
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await checkApp({ cwd: root, tsconfigPath: 'tsconfig.json', pretty: false });
      } finally {
        log.mockRestore();
      }
    }, 60_000);

    it('throws when tsc reports type errors', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-fail-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = "noop";\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await expect(checkApp({ cwd: root, pretty: false })).rejects.toThrow('Typecheck failed');
      } finally {
        log.mockRestore();
      }
    }, 60_000);

    it('stops upward search at a .git directory', () => {
      const root = mkdtempSync(join(tmpdir(), 'check-git-'));
      temps.push(root);
      writeFileSync(join(root, 'tsconfig.json'), '{}\n');
      const nested = join(root, 'pkg', 'src');
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(root, 'pkg', '.git'), { recursive: true });
      // start under pkg/src — hits pkg/.git before root tsconfig
      expect(findNearestTsconfig(nested)).toBeUndefined();
    });
  });

  describe('CLI entrypoint', () => {
    it('handleCheckFailure exits 1', () => {
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handleCheckFailure(new Error('boom'))).toThrow('EXIT_1');
        expect(code).toBe(1);
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('runCheckMain respects isMain', () => {
      let calls = 0;
      runCheckMain(false, async () => {
        calls++;
      });
      expect(calls).toBe(0);
      runCheckMain(true, async () => {
        calls++;
      });
      expect(calls).toBe(1);
    });

    it('check --help returns', async () => {
      await check(['--help']);
      await check(['-h']);
    });

    it('check runs against an explicit tsconfig path', async () => {
      const root = mkdtempSync(join(tmpdir(), 'check-cli-'));
      temps.push(root);
      mkdirSync(join(root, 'src'), { recursive: true });
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: 'esnext',
            target: 'esnext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.ts'],
        }) + '\n',
      );
      await Bun.write(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      try {
        process.chdir(root);
        await check(['tsconfig.json', '--no-pretty']);
      } finally {
        process.chdir(cwd);
        log.mockRestore();
      }
    }, 60_000);
  });
});
