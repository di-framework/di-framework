import { beforeEach, describe, expect, it } from 'bun:test';
import { Actor, ActorContext, ActorMethod, ActorRuntime } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Actor()
class SerialTestActor {
  @ActorContext
  private ctx!: ActorContext;

  private activeInvocations = 0;
  private maxConcurrentInvocations = 0;

  @ActorMethod()
  async doWork(id: number, durationMs: number): Promise<{ id: number; maxConcurrent: number }> {
    this.activeInvocations++;
    if (this.activeInvocations > this.maxConcurrentInvocations) {
      this.maxConcurrentInvocations = this.activeInvocations;
    }

    // Append to execution log in storage to test ordered interleaving
    const log = (await this.ctx.storage.get<string[]>('log')) ?? [];
    log.push(`start:${id}`);
    await this.ctx.storage.set('log', log);

    await sleep(durationMs);

    const logEnd = (await this.ctx.storage.get<string[]>('log')) ?? [];
    logEnd.push(`end:${id}`);
    await this.ctx.storage.set('log', logEnd);

    this.activeInvocations--;
    return { id, maxConcurrent: this.maxConcurrentInvocations };
  }

  @ActorMethod()
  async getExecutionLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('log')) ?? [];
  }

  @ActorMethod()
  async failThenSucceed(shouldFail: boolean, val: string): Promise<string> {
    if (shouldFail) {
      throw new Error('Forced failure');
    }
    return val;
  }
}

@Actor()
class ParallelWorkerActor {
  @ActorMethod()
  async delay(ms: number): Promise<number> {
    const start = Date.now();
    await sleep(ms);
    return Date.now() - start;
  }
}

describe('Actor Mailbox Serialization and Multi-Actor Concurrency', () => {
  let runtime: ActorRuntime;

  beforeEach(() => {
    runtime = new ActorRuntime();
    runtime.register(SerialTestActor);
    runtime.register(ParallelWorkerActor);
  });

  it('strictly serializes complete asynchronous invocations for the same actor', async () => {
    const actor = runtime.get(SerialTestActor, 'serial-1');

    // Launch 4 asynchronous invocations concurrently on the same actor
    const promises = [
      actor.doWork(1, 40),
      actor.doWork(2, 30),
      actor.doWork(3, 20),
      actor.doWork(4, 10),
    ];

    const results = await Promise.all(promises);

    // Every invocation must have seen maxConcurrent == 1 (never > 1!)
    for (const res of results) {
      expect(res.maxConcurrent).toBe(1);
    }

    // Execution log must be strictly: start:1, end:1, start:2, end:2, start:3, end:3, start:4, end:4
    const log = await actor.getExecutionLog();
    expect(log).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
      'start:4',
      'end:4',
    ]);
  });

  it('allows different actors to execute concurrently', async () => {
    const workerA = runtime.get(ParallelWorkerActor, 'worker-A');
    const workerB = runtime.get(ParallelWorkerActor, 'worker-B');
    const workerC = runtime.get(ParallelWorkerActor, 'worker-C');

    const startTime = Date.now();

    // Run 3 different actors for 60ms each in parallel
    const results = await Promise.all([workerA.delay(60), workerB.delay(60), workerC.delay(60)]);

    const totalElapsed = Date.now() - startTime;

    expect(results.length).toBe(3);
    // If they were serialized sequentially, total time would be >= 180ms.
    // Because they execute concurrently across different actors, total time should be around 60-120ms.
    expect(totalElapsed).toBeLessThan(160);
  });

  it('resumes mailbox queue even after an invocation throws an error', async () => {
    const actor = runtime.get(SerialTestActor, 'error-test');

    const p1 = actor.failThenSucceed(true, 'first');
    const p2 = actor.failThenSucceed(false, 'second');

    await expect(p1).rejects.toThrow('Forced failure');
    const r2 = await p2;
    expect(r2).toBe('second');
  });
});
