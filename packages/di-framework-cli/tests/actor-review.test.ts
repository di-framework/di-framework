import { expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runActorInspect } from '../cmd/actor/inspect';
import { runActorList } from '../cmd/actor/list';
import { loadActorOperations, parseActorCliArgs } from '../cmd/actor/options';
import { runActorReset } from '../cmd/actor/reset';
import { CommandFailure } from '../command';

it('parses actor options and rejects missing values and unknown flags', () => {
  expect(
    parseActorCliArgs([
      'Counter',
      '--dir=x',
      '--base-dir=y',
      '--namespace=app',
      '--key=k',
      '--actor=A',
      '--active',
      '--show-state',
      '--json',
      '--all',
    ]),
  ).toEqual({
    positional: ['Counter'],
    dir: 'y',
    namespace: 'app',
    key: 'k',
    actor: 'A',
    active: true,
    showState: true,
    json: true,
    all: true,
  });
  expect(() => parseActorCliArgs(['--unknown'])).toThrow('Unknown option');
  for (const flag of ['--dir', '--base-dir', '--namespace', '--key', '--actor']) {
    expect(() => parseActorCliArgs([flag])).toThrow('requires a value');
    expect(() => parseActorCliArgs([flag, '--json'])).toThrow('requires a value');
  }
});

it('loads actor operations through project and source fallbacks and reports unavailable packages', async () => {
  const operations = await loadActorOperations();
  let calls = 0;
  expect(
    await loadActorOperations(process.cwd(), async () => {
      if (++calls === 1) throw new Error('missing package');
      return operations;
    }),
  ).toBe(operations);
  expect(calls).toBe(2);
  calls = 0;
  expect(
    await loadActorOperations(process.cwd(), async () => {
      if (++calls < 3) throw new Error('missing package');
      return operations;
    }),
  ).toBe(operations);
  expect(calls).toBe(3);
  await expect(
    loadActorOperations(process.cwd(), async () => {
      throw new Error('missing');
    }),
  ).rejects.toMatchObject({ code: 'ACTORS_PACKAGE_UNAVAILABLE' });
});

it('formats empty lists, inspection details and failures while closing development managers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actor-cli-review-'));
  const operations = await loadActorOperations();
  const prototype = operations.ActorDevManager.prototype;
  try {
    expect((await runActorList(['--dir', dir])).text).toContain('No actors found');
    await expect(runActorInspect([])).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    const inspect = spyOn(prototype, 'inspect').mockResolvedValue(null);
    try {
      await expect(runActorInspect(['Unknown', '--dir', dir])).rejects.toMatchObject({
        code: 'ACTOR_NOT_FOUND',
      });
      inspect.mockResolvedValue({
        actorId: 'Counter:k',
        actorType: 'Counter',
        actorKey: 'k',
        status: 'inactive',
        runningCalls: 0,
        pendingCalls: 0,
        activeInstance: false,
        methods: ['increment'],
        migrationStatus: {
          failedMigration: { version: '2', error: 'bad migration', timestamp: 1 },
        },
      });
      const details = await runActorInspect(['Counter', '--dir', dir]);
      expect(details.text).toContain('Methods:       increment');
      expect(details.text).toContain('bad migration');
    } finally {
      inspect.mockRestore();
    }
    for (const [method, command, args, code] of [
      ['list', runActorList, ['--dir', dir], 'ACTOR_LIST_ERROR'],
      ['inspect', runActorInspect, ['Counter', '--dir', dir], 'ACTOR_INSPECT_ERROR'],
      ['reset', runActorReset, ['--all', '--dir', dir], 'ACTOR_RESET_ERROR'],
    ] as const) {
      const failure = spyOn(prototype, method).mockRejectedValue(new Error('operation failed'));
      try {
        await expect(command(args)).rejects.toMatchObject({ code });
        const existing = new CommandFailure('EXISTING', 'original', 2);
        failure.mockRejectedValue(existing);
        await expect(command(args)).rejects.toBe(existing);
      } finally {
        failure.mockRestore();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
