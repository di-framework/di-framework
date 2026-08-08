import { describe, expect, it, spyOn } from 'bun:test';
import { handleMxFailure, MX_COMMANDS, printMxHelp, runMxMain } from '../cmd/mx';

describe('mx (maintainer) router', () => {
  it('lists build, test, typecheck, publish', () => {
    expect(Object.keys(MX_COMMANDS).sort()).toEqual(['build', 'publish', 'test', 'typecheck']);
  });

  it('printMxHelp mentions maintainer scope', () => {
    const chunks: string[] = [];
    const stream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    printMxHelp(stream);
    const text = chunks.join('');
    expect(text).toContain('mx');
    expect(text).toContain('build');
    expect(text).toContain('publish');
  });

  it('handleMxFailure exits 1', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const originalExit = process.exit;
    let code: number | undefined;
    (process as any).exit = (c: number) => {
      code = c;
      throw new Error(`EXIT_${c}`);
    };
    try {
      expect(() => handleMxFailure(new Error('boom'))).toThrow('EXIT_1');
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('runMxMain respects isMain', () => {
    let calls = 0;
    runMxMain(false, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    runMxMain(true, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it('mx without subcommand exits 1 after help', async () => {
    const { mx } = await import('../cmd/mx');
    const originalExit = process.exit;
    let code: number | undefined;
    (process as any).exit = (c: number) => {
      code = c;
      throw new Error(`EXIT_${c}`);
    };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    // printMxHelp writes to stderr via stream write — also process.stderr
    try {
      await expect(mx([])).rejects.toThrow('EXIT_1');
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('mx unknown subcommand exits 1', async () => {
    const { mx } = await import('../cmd/mx');
    const originalExit = process.exit;
    (process as any).exit = (c: number) => {
      throw new Error(`EXIT_${c}`);
    };
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(mx(['nope'])).rejects.toThrow('EXIT_1');
    } finally {
      process.exit = originalExit;
      err.mockRestore();
    }
  });

  it('mx help returns without exit', async () => {
    const { mx } = await import('../cmd/mx');
    await mx(['help']);
  });
});
