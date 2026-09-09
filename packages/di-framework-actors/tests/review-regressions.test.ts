import { describe, expect, it } from 'bun:test';
import { ActorContext, ActorMethod, ActorRuntime } from '../src/index.js';
import { ActorMailbox } from '../src/runtime/mailbox.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Actor invocation lifecycle regressions', () => {
  it('rejects self-invocation instead of deadlocking and leaves the actor usable', async () => {
    class SelfActor {
      @ActorContext ctx!: ActorContext;
      async nested() {
        return this.ctx.actors.get(SelfActor, this.ctx.actorKey).read();
      }
      async read() {
        return 42;
      }
    }
    const runtime = new ActorRuntime({ actors: [SelfActor] });
    const ref = runtime.get(SelfActor, 'self');
    await expect(ref.nested()).rejects.toThrow('Reentrant invocation');
    expect(await ref.read()).toBe(42);
  });

  it('rejects queued callers when the mailbox is cleared', async () => {
    const gate = deferred<number>();
    const mailbox = new ActorMailbox();
    const active = mailbox.enqueue(() => gate.promise);
    const queued = mailbox.enqueue(async () => 2);
    const rejected = queued.catch((error) => error);
    expect(mailbox.isBusy).toBe(true);
    expect(mailbox.queueLength).toBe(1);
    mailbox.clear();
    expect((await rejected).message).toContain('mailbox cleared');
    gate.resolve(1);
    expect(await active).toBe(1);
    expect(await mailbox.enqueue(async () => 3)).toBe(3);
  });

  for (const action of ['deactivate', 'clear'] as const) {
    it(`${action} settles queued actor invocations`, async () => {
      const entered = deferred<void>();
      const release = deferred<number>();
      class SlowActor {
        async slow() {
          entered.resolve();
          return release.promise;
        }
        async read() {
          return 2;
        }
      }
      const runtime = new ActorRuntime({ actors: [SlowActor] });
      const ref = runtime.get(SlowActor, 'key');
      const active = ref.slow();
      await entered.promise;
      const pending = ref.read();
      const rejected = pending.catch((error) => error);
      if (action === 'clear') await runtime.clear();
      else await runtime.deactivate(SlowActor, 'key');
      expect((await rejected).message).toContain('mailbox cleared');
      release.resolve(1);
      expect(await active).toBe(1);
    });
  }

  it('observes late timeout rejections and rolls back storage writes', async () => {
    const release = deferred<void>();
    const finished = deferred<void>();
    class TimeoutActor {
      @ActorContext ctx!: ActorContext;
      @ActorMethod({ timeout: 5 })
      async slow() {
        await this.ctx.storage.set('value', 1);
        await release.promise;
        try {
          await this.ctx.storage.set('value', 2);
        } finally {
          finished.resolve();
        }
      }
      @ActorMethod()
      async read() {
        return this.ctx.storage.get('value');
      }
    }
    const runtime = new ActorRuntime({ actors: [TimeoutActor] });
    const ref = runtime.get(TimeoutActor, 'key');
    await expect(ref.slow()).rejects.toThrow('timed out');
    release.resolve();
    await finished.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await ref.read()).toBeUndefined();
  });
});

it('exposes actor metadata, context construction, storage and symbol-safe references', async () => {
  const { getActorMetadata, getTargetConstructor } = await import('../src/decorators/keys.js');
  const { InMemoryActorStorage } = await import('../src/storage/memory.js');
  class Example {
    read() {
      return 1;
    }
  }
  expect(getActorMetadata(Example)).toBeUndefined();
  expect(getTargetConstructor(null)).toBeNull();
  const storage = new InMemoryActorStorage();
  const runtime = new ActorRuntime({ storage, actors: [Example] });
  expect(runtime.storage).toBe(storage);
  expect(getActorMetadata(Example)?.name).toBe('Example');
  expect((runtime.get(Example, 'key') as any)[Symbol.iterator]).toBeUndefined();
  const tx = await storage.beginTransaction('Example:key');
  const ctx = new ActorContext({
    actorId: 'Example:key',
    actorKey: 'key',
    actorType: 'Example',
    storage: tx,
    actors: runtime,
  });
  expect(ctx).toBeInstanceOf(ActorContext);
  expect(ctx.actorKey).toBe('key');
  await tx.rollback();
});
