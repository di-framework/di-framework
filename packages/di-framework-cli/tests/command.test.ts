import { describe, expect, it } from 'bun:test';
import { CommandFailure, type CommandNode, executeCommand, formatCommandHelp } from '../command';

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

function fixture(run?: CommandNode['run']): CommandNode {
  return {
    description: 'Fixture root',
    children: {
      tools: {
        description: 'Tool commands',
        children: {
          inspect: {
            description: 'Inspect a fixture',
            usage: 'di-framework tools inspect <path>',
            options: ['--verbose  Include details'],
            run:
              run ??
              ((context) => {
                context.io.stdout.write(`path=${context.command.join('/')}\n`);
                context.io.stderr.write('diagnostic\n');
                return { data: { args: context.args }, text: 'done' };
              }),
          },
        },
      },
    },
  };
}

describe('shared command execution', () => {
  it('routes nested leaves once and forwards only leaf arguments', async () => {
    const captured = captureIo();
    expect(await executeCommand(fixture(), ['tools', 'inspect', 'target'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toBe('path=tools/inspect\ndone\n');
    expect(captured.stderr.join('')).toBe('diagnostic\n');
  });

  it('supports global JSON before or after the command path', async () => {
    for (const argv of [
      ['--json', 'tools', 'inspect', 'target'],
      ['tools', 'inspect', '--json', 'target'],
    ]) {
      const captured = captureIo();
      expect(await executeCommand(fixture(), argv, captured.io)).toBe(0);
      expect(captured.stderr).toEqual([]);
      expect(JSON.parse(captured.stdout.join(''))).toEqual({
        schemaVersion: 1,
        command: 'tools inspect',
        ok: true,
        data: { args: ['target'] },
      });
    }
  });

  it('normalizes void results and preserves negative domain statuses', async () => {
    const empty = captureIo();
    expect(
      await executeCommand(
        fixture(() => undefined),
        ['tools', 'inspect', '--json'],
        empty.io,
      ),
    ).toBe(0);
    expect(JSON.parse(empty.stdout.join('')).data).toBeNull();

    const negative = captureIo();
    expect(
      await executeCommand(
        fixture(() => ({ exitCode: 1, data: { valid: false } })),
        ['tools', 'inspect', '--json'],
        negative.io,
      ),
    ).toBe(1);
    expect(JSON.parse(negative.stdout.join(''))).toMatchObject({
      ok: false,
      data: { valid: false },
    });
  });

  it('renders explicit root, group, and leaf help in text and JSON', async () => {
    const root = captureIo();
    expect(await executeCommand(fixture(), ['help'], root.io)).toBe(0);
    expect(root.stdout.join('')).toContain('tools');

    const group = captureIo();
    expect(await executeCommand(fixture(), ['tools', '-h'], group.io)).toBe(0);
    expect(group.stdout.join('')).toContain('inspect');

    const leaf = captureIo();
    expect(await executeCommand(fixture(), ['tools', 'inspect', '--help', '--json'], leaf.io)).toBe(
      0,
    );
    const envelope = JSON.parse(leaf.stdout.join(''));
    expect(envelope.command).toBe('tools inspect');
    expect(envelope.data.help).toContain('--verbose');
  });

  it('reports missing and unknown nested commands with nearest help', async () => {
    const missing = captureIo();
    expect(await executeCommand(fixture(), ['tools'], missing.io)).toBe(2);
    expect(missing.stderr.join('')).toContain('Missing command after di-framework tools');
    expect(missing.stderr.join('')).toContain('inspect');

    const unknown = captureIo();
    expect(await executeCommand(fixture(), ['tools', 'nope'], unknown.io)).toBe(2);
    expect(unknown.stderr.join('')).toContain('Unknown command: tools nope');
    expect(unknown.stderr.join('')).toContain('inspect');
  });

  it('serializes typed failures and unexpected failures with stable exit codes', async () => {
    const typed = captureIo();
    expect(
      await executeCommand(
        fixture(() => {
          throw new CommandFailure('BAD_CONFIG', 'Configuration is invalid', 2, { field: 'root' });
        }),
        ['tools', 'inspect', '--json'],
        typed.io,
      ),
    ).toBe(2);
    expect(JSON.parse(typed.stdout.join('')).error).toEqual({
      code: 'BAD_CONFIG',
      message: 'Configuration is invalid',
      details: { field: 'root' },
    });

    const unexpected = captureIo();
    expect(
      await executeCommand(
        fixture(() => {
          throw 'boom';
        }),
        ['tools', 'inspect'],
        unexpected.io,
      ),
    ).toBe(3);
    expect(unexpected.stderr.join('')).toBe('Unexpected command failure\n');

    const errorObject = captureIo();
    await executeCommand(
      fixture(() => {
        throw new Error('broken');
      }),
      ['tools', 'inspect', '--json'],
      errorObject.io,
    );
    expect(JSON.parse(errorObject.stdout.join('')).error.details).toEqual({ cause: 'broken' });
  });

  it('rejects non-executable leaves and formats standalone leaf help', async () => {
    const captured = captureIo();
    expect(await executeCommand({ description: 'Not runnable' }, ['--json'], captured.io)).toBe(2);
    expect(JSON.parse(captured.stdout.join('')).error.code).toBe('INVALID_COMMAND');

    const help = formatCommandHelp({
      description: 'Standalone',
      options: ['--flag  A flag'],
      run: () => undefined,
    });
    expect(help).toContain('di-framework [options]');
    expect(help).toContain('--flag');
  });
});
