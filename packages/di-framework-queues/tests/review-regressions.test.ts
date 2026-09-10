import { expect, test } from 'bun:test';
import { QueueHandler as CoreQueueHandler } from '@di-framework/core';
import { InMemoryQueueBackend } from '../src/backend/memory';
import { SqliteQueueBackend } from '../src/backend/sqlite';
import { getQueueHandlerMetadata, QueueHandler, queueRegistry } from '../src/decorators';
import { ContainerQueueDispatcher } from '../src/dispatcher';
import { QueueManager } from '../src/producer';
import { QueueWorker } from '../src/worker';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('core and queues decorators share discovery, defaults, and explicit overrides', async () => {
  class Handler {
    handle(payload: unknown) {
      return payload;
    }
  }
  CoreQueueHandler('review-defaults', { maxRetries: 5, backoffMs: 7, timeoutMs: 25 })(
    Handler.prototype,
    'handle',
  );
  QueueHandler('review-second')(Handler.prototype, 'handle');
  expect(getQueueHandlerMetadata(Handler)).toHaveLength(2);
  expect(getQueueHandlerMetadata(Handler.prototype)).toHaveLength(2);
  expect(getQueueHandlerMetadata(class Empty {})).toEqual([]);
  expect(getQueueHandlerMetadata({})).toEqual([]);
  for (const backend of [new InMemoryQueueBackend(), new SqliteQueueBackend()]) {
    const manager = new QueueManager(backend);
    const producer = manager.get('review-defaults');
    expect(manager.get('review-defaults')).toBe(producer);
    const job = await producer.enqueue({ ok: true });
    expect(job).toMatchObject({ maxRetries: 5, backoffMs: 7, timeoutMs: 25 });
    expect(await producer.getJob(job.id)).toEqual(job);
    expect(await producer.listJobs()).toHaveLength(1);
    const override = await producer.enqueue({}, { maxRetries: 1, backoffMs: 0, timeoutMs: 50 });
    expect(override).toMatchObject({ maxRetries: 1, backoffMs: 0, timeoutMs: 50 });
    const replacement = new InMemoryQueueBackend();
    manager.setBackend(replacement);
    expect(manager.getBackend()).toBe(replacement);
    expect(await producer.listJobs()).toEqual([]);
    manager.clear();
    expect(manager.get('review-defaults')).not.toBe(producer);
    await backend.close();
    await replacement.close();
  }
  const db = new SqliteQueueBackend();
  expect(db.getDatabase().query('SELECT 1 AS value').get()).toEqual({ value: 1 });
  await db.close();
});

test('dispatcher chooses a registered container service and supports custom handlers', async () => {
  class First {
    run() {
      return 'first';
    }
  }
  class Second {
    run() {
      return 'second';
    }
  }
  QueueHandler('review-choice')(First.prototype, 'run');
  QueueHandler('review-choice')(Second.prototype, 'run');
  const backend = new InMemoryQueueBackend();
  const job = await backend.enqueue('review-choice', {});
  const dispatcher = new ContainerQueueDispatcher({
    resolve: <T>(token: any) => new token() as T,
    has: (token: any) => token === First,
  } as any);
  expect(await dispatcher.dispatch<unknown, string>(job)).toBe('first');
  dispatcher.setContainer({ resolve: <T>(token: any) => new token() as T });
  expect(await dispatcher.dispatch<unknown, string>(job)).toBe('second');
  dispatcher.registerHandler('review-choice', First, 'run');
  expect(await dispatcher.dispatch<unknown, string>(job)).toBe('first');
  await backend.close();
});

test('worker honors explicit queues, discovers shared decorators, and processes single jobs', async () => {
  class Handler {
    run() {
      return true;
    }
  }
  CoreQueueHandler('review-worker')(Handler.prototype, 'run');
  const backend = new InMemoryQueueBackend();
  const worker = new QueueWorker(backend, undefined, {
    queues: ['review-worker'],
    recoveryIntervalMs: 2,
  });
  expect(worker.getRegisteredQueues()).toEqual(['review-worker']);
  expect(worker.isRunning()).toBe(false);
  expect(await worker.processNext('review-worker')).toBe(false);
  const job = await backend.enqueue('review-worker', {});
  expect(await worker.processNext('review-worker')).toBe(true);
  expect((await backend.getJob(job.id))?.status).toBe('completed');
  const discovered = new QueueWorker(backend, undefined, { recoveryIntervalMs: 2 });
  discovered.registerAllDeclaredQueues();
  expect(discovered.getRegisteredQueues()).toContain('review-worker');
  await discovered.start();
  await pause(8);
  await discovered.stop();
  await backend.close();
});

test('pump drains jobs without background timers and ignores recovery failures', async () => {
  class Handler {
    seen: unknown[] = [];
    run(payload: unknown) {
      this.seen.push(payload);
      return payload;
    }
  }
  QueueHandler('review-pump')(Handler.prototype, 'run');
  const backend = new InMemoryQueueBackend();
  const handler = new Handler();
  const dispatcher = {
    dispatch: async (_queueName: string, job: { payload: unknown }) => handler.run(job.payload),
  };
  const worker = new QueueWorker(backend, dispatcher as any, { pollIntervalMs: 5 });
  await backend.enqueue('review-pump', { n: 1 });
  await backend.enqueue('review-pump', { n: 2 });
  expect(await worker.pump(1)).toBe(1);
  expect(await worker.pump()).toBe(1);
  expect(handler.seen).toEqual([{ n: 1 }, { n: 2 }]);

  const flaky = new InMemoryQueueBackend();
  flaky.recoverUnacknowledged = async () => {
    throw new Error('recovery unavailable');
  };
  await flaky.enqueue('review-pump', { n: 3 });
  const recovered = new QueueWorker(flaky, dispatcher as any);
  expect(await recovered.pump(2)).toBe(1);
  await backend.close();
  await flaky.close();
});

test('shutdown waits for in-flight work and late timeout rejections remain observed', async () => {
  const backend = new InMemoryQueueBackend();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  const dispatcher = {
    dispatch: async () => {
      entered();
      await held;
    },
  } as any;
  const worker = new QueueWorker(backend, dispatcher, { queues: ['review-held'] });
  const job = await backend.enqueue('review-held', {});
  await worker.start();
  await started;
  const stopping = worker.stop(1000);
  release();
  await stopping;
  expect((await backend.getJob(job.id))?.status).toBe('completed');
  class LateFailure {
    async run() {
      await pause(15);
      throw new Error('late failure');
    }
  }
  const timed = new ContainerQueueDispatcher({ resolve: <T>() => new LateFailure() as T });
  timed.registerHandler('review-late', LateFailure, 'run');
  const late = await backend.enqueue('review-late', {}, { timeoutMs: 1 });
  await expect(timed.dispatch(late)).rejects.toThrow('timed out');
  await pause(25);
  await backend.close();
});

test('registry clear resets discovery', () => {
  const existing = queueRegistry.getAll();
  queueRegistry.clear();
  expect(queueRegistry.getAll()).toEqual([]);
  for (const handler of existing) queueRegistry.register(handler);
});

test('independent SQLite processes claim each job only once', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'queue-claim-review-'));
  const path = join(root, 'queue.db');
  const backend = new SqliteQueueBackend(path);
  try {
    for (let i = 0; i < 40; i++) await backend.enqueue('claims', { i });
    const script = join(root, 'consumer.ts');
    writeFileSync(
      script,
      `import { SqliteQueueBackend } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/backend/sqlite.ts')).href)};
      const backend = new SqliteQueueBackend(process.argv[2]);
      const ids = [];
      while (true) {
        const job = await backend.dequeue('claims');
        if (!job) break;
        ids.push(job.id);
        await backend.complete(job.id);
        await new Promise(r => setTimeout(r, 1));
      }
      console.log(JSON.stringify(ids));
      await backend.close();`,
    );
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, script, path], { stdout: 'pipe', stderr: 'pipe' }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        return JSON.parse(stdout) as string[];
      }),
    );
    expect(results.flat()).toHaveLength(40);
    expect(new Set(results.flat()).size).toBe(40);
    expect((await backend.listQueues())[0]?.completed).toBe(40);
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
