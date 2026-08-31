import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleInitFailure,
  init,
  parseInitArgs,
  printInitHelp,
  runInitMain,
  scaffoldApp,
} from '../cmd/init';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('init command', () => {
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

  describe('parseInitArgs', () => {
    it('defaults name and dir from positional', () => {
      const opts = parseInitArgs(['my-api']);
      expect(opts.name).toBe('my-api');
      expect(opts.dir).toBe(join(process.cwd(), 'my-api'));
      expect(opts.force).toBe(false);
    });

    it('defaults to di-app when no args', () => {
      const opts = parseInitArgs([]);
      expect(opts.name).toBe('di-app');
      expect(opts.dir).toBe(join(process.cwd(), 'di-app'));
    });

    it('honors --dir and --force', () => {
      const opts = parseInitArgs(['--dir', '/tmp/x', '--name', 'n', '--force']);
      expect(opts.dir).toBe('/tmp/x');
      expect(opts.name).toBe('n');
      expect(opts.force).toBe(true);
    });

    it('honors short flags -d -n -f', () => {
      const opts = parseInitArgs(['-d', '/tmp/y', '-n', 'short', '-f']);
      expect(opts.dir).toBe('/tmp/y');
      expect(opts.name).toBe('short');
      expect(opts.force).toBe(true);
    });

    it('throws HELP for --help / -h', () => {
      expect(() => parseInitArgs(['--help'])).toThrow('HELP');
      expect(() => parseInitArgs(['-h'])).toThrow('HELP');
    });

    it('throws on unknown flags and missing --dir value', () => {
      expect(() => parseInitArgs(['--nope'])).toThrow('Unknown flag');
      expect(() => parseInitArgs(['--dir'])).toThrow('requires a path');
    });
  });

  describe('printInitHelp / init()', () => {
    it('printInitHelp writes usage', () => {
      const chunks: string[] = [];
      printInitHelp({
        write: (s: string) => {
          chunks.push(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream);
      expect(chunks.join('')).toContain('Scaffold');
    });

    it('init --help prints help without throwing', async () => {
      await init(['--help']);
    });

    it('init scaffolds into --dir', async () => {
      const root = mkdtempSync(join(tmpdir(), 'init-cli-'));
      temps.push(root);
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await init(['demo', '--dir', root, '--force']);
        expect(await Bun.file(join(root, 'src', 'index.ts')).exists()).toBe(true);
      } finally {
        log.mockRestore();
      }
    });

    it('init rethrows non-HELP errors', async () => {
      await expect(init(['--unknown'])).rejects.toThrow('Unknown flag');
    });
  });

  describe('scaffoldApp', () => {
    it('writes package.json, tsconfig, src, and README', () => {
      const root = mkdtempSync(join(tmpdir(), 'init-'));
      temps.push(root);
      const dir = join(root, 'app');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        scaffoldApp({ dir, name: 'app', force: false });
        expect(existsSync(join(dir, 'package.json'))).toBe(true);
        expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true);
        expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true);
        expect(existsSync(join(dir, 'README.md'))).toBe(true);

        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        expect(pkg.dependencies['@di-framework/core']).toBe('latest');
        expect(pkg.devDependencies['@di-framework/cli']).toBe('latest');
        expect(pkg.devDependencies['@di-framework/tsc']).toBe('latest');
        expect(pkg.devDependencies.ttsc).toBeUndefined();
        expect(pkg.devDependencies.typescript).toBeUndefined();
        expect(pkg.scripts.build).toBe('di-framework build');
        expect(pkg.scripts.check).toBe('di-framework check');
        expect(pkg.scripts.start).toBe('node dist/index.js');

        const ts = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf-8'));
        expect(ts.compilerOptions.experimentalDecorators).toBe(true);
        expect(ts.compilerOptions.emitDecoratorMetadata).toBe(false);
        expect(ts.compilerOptions.outDir).toBe('dist');
        expect(ts.compilerOptions.rootDir).toBe('src');
        expect(ts.compilerOptions.types).toEqual(['bun']);
        expect(ts.compilerOptions.module).toBe('NodeNext');
        expect(ts.compilerOptions.moduleResolution).toBe('NodeNext');
        expect(ts.compilerOptions.plugins).toEqual([{ transform: '@di-framework/tsc' }]);
        expect(ts.compilerOptions.noEmit).toBeUndefined();
        expect(ts.compilerOptions.allowImportingTsExtensions).toBeUndefined();

        const readme = readFileSync(join(dir, 'README.md'), 'utf-8');
        expect(readme).toContain('@di-framework/tsc');
        expect(readme).toContain('di-framework build');
        expect(readme).toContain('di-framework check');

        const src = readFileSync(join(dir, 'src', 'index.ts'), 'utf-8');
        expect(src).toContain('@Container()');
        expect(src).toContain('@di-framework/core');
        expect(src).toContain('hello(name: string)');
        expect(src).not.toContain('function greet(name: string)');
      } finally {
        log.mockRestore();
      }
    });

    it('skips existing files without --force', async () => {
      const root = mkdtempSync(join(tmpdir(), 'init-skip-'));
      temps.push(root);
      const dir = join(root, 'app');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        scaffoldApp({ dir, name: 'app', force: false });
        await Bun.write(join(dir, 'package.json'), '{"name":"kept"}\n');
        scaffoldApp({ dir, name: 'app', force: false });
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        expect(pkg.name).toBe('kept');
      } finally {
        log.mockRestore();
      }
    });

    it('overwrites with --force and prints absolute next-step path', () => {
      const root = mkdtempSync(join(tmpdir(), 'init-force-'));
      temps.push(root);
      const dir = join(root, 'elsewhere');
      const logs: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });
      try {
        scaffoldApp({ dir, name: 'app', force: false });
        scaffoldApp({ dir, name: 'app', force: true });
        expect(logs.some((l) => l.includes(dir))).toBe(true);
      } finally {
        log.mockRestore();
      }
    });

    it('rethrows unexpected open errors when not forcing', () => {
      const root = mkdtempSync(join(tmpdir(), 'init-err-'));
      temps.push(root);
      const dir = join(root, 'app');
      const log = spyOn(console, 'log').mockImplementation(() => {});
      const open = spyOn(fs, 'openSync').mockImplementation(() => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });
      try {
        expect(() => scaffoldApp({ dir, name: 'app', force: false })).toThrow('permission denied');
      } finally {
        open.mockRestore();
        log.mockRestore();
      }
    });
  });

  describe('CLI entrypoint', () => {
    it('handleInitFailure logs and exits 1', () => {
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const originalExit = process.exit;
      let code: number | undefined;
      (process as any).exit = (c: number) => {
        code = c;
        throw new Error(`EXIT_${c}`);
      };
      try {
        expect(() => handleInitFailure(new Error('boom'))).toThrow('EXIT_1');
        expect(code).toBe(1);
      } finally {
        process.exit = originalExit;
        err.mockRestore();
      }
    });

    it('runInitMain only when isMain', () => {
      let calls = 0;
      runInitMain(false, async () => {
        calls++;
      });
      expect(calls).toBe(0);
      runInitMain(true, async () => {
        calls++;
      });
      expect(calls).toBe(1);
    });
  });
});
