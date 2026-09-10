import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQueueInspectArgs, runQueueInspect } from '../cmd/queue/inspect';
import { parseQueueListArgs, runQueueList } from '../cmd/queue/list';
import { openQueueBackend, resolveQueueDbPath } from '../cmd/queue/options';
import { parseQueueRetryArgs, runQueueRetry } from '../cmd/queue/retry';

test('queue parsers reject incomplete flags and extra arguments', () => {
  for (const args of [['--db'], ['--db', '--json']])
    expect(() => parseQueueListArgs(args)).toThrow('Missing');
  for (const args of [
    [],
    ['q', '--status'],
    ['q', '--status', 'bad'],
    ['q', '--limit'],
    ['q', '--limit', '0'],
    ['q', '--limit', 'bad'],
    ['q', '--db'],
    ['q', '--unknown'],
    ['q', 'extra'],
  ])
    expect(() => parseQueueInspectArgs(args)).toThrow();
  expect(parseQueueInspectArgs(['q', '--limit', '3'])).toMatchObject({ limit: 3 });
  for (const args of [[], ['q', '--db'], ['q', '--unknown'], ['q', 'id', 'extra']])
    expect(() => parseQueueRetryArgs(args)).toThrow();
  expect(parseQueueRetryArgs(['q', 'id', '--json'])).toMatchObject({
    queueName: 'q',
    jobId: 'id',
    json: true,
  });
});

test('queue database selection follows explicit, environment, and project paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-path-review-'));
  const previous = process.env.DI_QUEUE_DB;
  try {
    delete process.env.DI_QUEUE_DB;
    expect(resolveQueueDbPath('custom.db', root)).toBe(join(root, 'custom.db'));
    expect(resolveQueueDbPath(join(root, 'absolute.db'), root)).toBe(join(root, 'absolute.db'));
    expect(resolveQueueDbPath(undefined, root)).toBe(join(root, '.di-framework', 'queue.db'));
    writeFileSync(join(root, 'queue.db'), '');
    expect(resolveQueueDbPath(undefined, root)).toBe(join(root, 'queue.db'));
    mkdirSync(join(root, '.di-framework'));
    writeFileSync(join(root, '.di-framework', 'queue.db'), '');
    expect(resolveQueueDbPath(undefined, root)).toBe(join(root, '.di-framework', 'queue.db'));
    process.env.DI_QUEUE_DB = 'environment.db';
    expect(resolveQueueDbPath(undefined, root)).toBe(join(root, 'environment.db'));
    process.env.DI_QUEUE_DB = join(root, 'environment.db');
    expect(resolveQueueDbPath(undefined, root)).toBe(process.env.DI_QUEUE_DB);
  } finally {
    if (previous === undefined) delete process.env.DI_QUEUE_DB;
    else process.env.DI_QUEUE_DB = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('queue commands report empty results and retry JSON consistently', async () => {
  const out: string[] = [];
  const io = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (_s: string) => true },
  };
  await runQueueList(['--db', ':memory:'], io);
  await runQueueInspect(['empty', '--db', ':memory:'], io);
  await runQueueRetry(['empty', '--db', ':memory:'], io);
  await runQueueRetry(['empty', 'missing', '--db', ':memory:'], io);
  expect(out.join('')).toContain('No durable queues');
  expect(out.join('')).toContain('No jobs found');
  expect(out.join('')).toContain('No dead-letter jobs');
  expect(out.join('')).toContain('No dead-letter job found with ID');
  out.length = 0;
  await runQueueRetry(['empty', '--db', ':memory:', '--json'], io);
  expect(JSON.parse(out.join(''))).toEqual({ retried: [] });
});

test('queue loader reports missing package with stable command failure', async () => {
  await expect(
    openQueueBackend(':memory:', async () => {
      throw new Error('unavailable');
    }),
  ).rejects.toMatchObject({ code: 'QUEUES_PACKAGE_UNAVAILABLE' });
  await expect(
    openQueueBackend(':memory:', async () => {
      throw 'unavailable';
    }),
  ).rejects.toMatchObject({ code: 'QUEUES_PACKAGE_UNAVAILABLE' });
});
