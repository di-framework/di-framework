import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from '../command';
import {
  type CliHandlers,
  COMMAND_TREE,
  createCommandTree,
  main,
  printHelp,
  runMain,
} from '../main';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
  };
}

describe('CLI main router', () => {
  const temps: string[] = [];
  afterEach(() => {
    process.chdir(REPO_ROOT);
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('defines app commands and nested mx commands', () => {
    expect(Object.keys(COMMAND_TREE.children ?? {})).toEqual([
      'init',
      'generate',
      'build',
      'check',
      'mx',
    ]);
    expect(Object.keys(COMMAND_TREE.children?.mx?.children ?? {})).toEqual([
      'build',
      'test',
      'typecheck',
      'publish',
    ]);
  });

  it('prints root help to an injected stream', () => {
    const chunks: string[] = [];
    printHelp({ write: (chunk) => chunks.push(chunk) });
    expect(chunks.join('')).toContain('di-framework <command>');
    expect(chunks.join('')).toContain('mx');
  });

  it('returns success for explicit help without global console mutation', async () => {
    const captured = captureIo();
    expect(await main(['--help'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('Commands:');
    expect(captured.stderr).toEqual([]);
  });

  it('returns usage status for missing and unknown commands', async () => {
    const missing = captureIo();
    expect(await main([], missing.io)).toBe(2);
    expect(missing.stderr.join('')).toContain('Missing command');

    const unknown = captureIo();
    expect(await main(['typecheck'], unknown.io)).toBe(2);
    expect(unknown.stderr.join('')).toContain('Unknown command: typecheck');
  });

  it('shows nested mx help through shared routing', async () => {
    const captured = captureIo();
    expect(await main(['mx', 'help'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('publish');
  });

  it('delegates every registered leaf through injectable handlers', async () => {
    const calls: Array<[string, unknown]> = [];
    const handlers: CliHandlers = {
      init: async (args) => void calls.push(['init', args]),
      generate: async (args) => void calls.push(['generate', args]),
      build: async (args) => void calls.push(['build', args]),
      check: async (args) => void calls.push(['check', args]),
      mxBuild: async (options) => void calls.push(['mx build', options]),
      mxTest: async () => void calls.push(['mx test', undefined]),
      mxTypecheck: async (argv) => void calls.push(['mx typecheck', argv]),
      mxPublish: async () => void calls.push(['mx publish', undefined]),
    };
    const tree = createCommandTree(handlers);
    for (const argv of [
      ['init', 'app'],
      ['generate', '--check'],
      ['build', '--watch'],
      ['check', 'tsconfig.app.json'],
      ['mx', 'build', '--sync-versions'],
      ['mx', 'test'],
      ['mx', 'typecheck', '--pretty=0'],
      ['mx', 'publish'],
    ]) {
      expect(await executeCommand(tree, argv, captureIo().io)).toBe(0);
    }
    expect(calls).toEqual([
      ['init', ['app']],
      ['generate', ['--check']],
      ['build', ['--watch']],
      ['check', ['tsconfig.app.json']],
      ['mx build', { syncVersions: true }],
      ['mx test', undefined],
      ['mx typecheck', ['bun', 'typecheck', '--pretty=0']],
      ['mx publish', undefined],
    ]);
  });

  it('runs an existing leaf command through the shared router', async () => {
    const root = mkdtempSync(join(tmpdir(), 'main-init-'));
    temps.push(root);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['init', 'demo', '--dir', root, '--force'], captureIo().io)).toBe(0);
      expect(await Bun.file(join(root, 'package.json')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'src', 'index.ts')).exists()).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('runMain only starts at the executable boundary and assigns the returned status', async () => {
    let calls = 0;
    let assigned: number | undefined;
    runMain(false, async () => {
      calls++;
      return 0;
    });
    runMain(
      true,
      async () => {
        calls++;
        return 2;
      },
      (exitCode) => {
        assigned = exitCode;
      },
    );
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(assigned).toBe(2);

    runMain(true, async () => 0);
    await Bun.sleep(0);
    expect(process.exitCode).toBe(0);
  });
});
