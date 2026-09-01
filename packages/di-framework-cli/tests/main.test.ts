import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMainFailure, main, printHelp, runMain } from '../main';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('CLI main router', () => {
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

  it('printHelp lists app commands and mx', () => {
    const chunks: string[] = [];
    const stream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    printHelp(stream);
    const text = chunks.join('');
    expect(text).toContain('init');
    expect(text).toContain('build');
    expect(text).toContain('check');
    expect(text).toContain('mx');
  });

  it('main help exits cleanly when help requested', async () => {
    await main(['--help']);
  });

  it('main without command prints help and exits 1', async () => {
    const originalExit = process.exit;
    let code: number | undefined;
    (process as any).exit = (c: number) => {
      code = c;
      throw new Error(`EXIT_${c}`);
    };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(main([])).rejects.toThrow('EXIT_1');
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('unknown command exits 1', async () => {
    const originalExit = process.exit;
    let code: number | undefined;
    (process as any).exit = (c: number) => {
      code = c;
      throw new Error(`EXIT_${c}`);
    };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(main(['noop'])).rejects.toThrow('EXIT_1');
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('rejects legacy top-level maintainer commands', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const originalExit = process.exit;
    (process as any).exit = (c: number) => {
      throw new Error(`EXIT_${c}`);
    };
    try {
      await expect(main(['typecheck'])).rejects.toThrow('EXIT_1');
      expect(err.mock.calls.some((c) => String(c[0]).includes('Unknown command: typecheck'))).toBe(
        true,
      );
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  }, 30_000);

  it('init via main scaffolds into a temp dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'main-init-'));
    temps.push(root);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['init', 'demo', '--dir', root, '--force']);
      expect(await Bun.file(join(root, 'package.json')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'src', 'index.ts')).exists()).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('handleMainFailure exits 1', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const originalExit = process.exit;
    let code: number | undefined;
    (process as any).exit = (c: number) => {
      code = c;
      throw new Error(`EXIT_${c}`);
    };
    try {
      expect(() => handleMainFailure(new Error('boom'))).toThrow('EXIT_1');
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('runMain respects isMain', () => {
    let calls = 0;
    runMain(false, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    runMain(true, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });
});
