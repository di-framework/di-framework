import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor, ActorContext, ActorRuntime, SqliteActorStorage } from '../src/index';

it('lists original persisted identities after restart without duplicating active actors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actor-identity-review-'));
  @Actor({ namespace: 'app' })
  class Counter {
    read() {
      return 1;
    }
  }
  let runtime = new ActorRuntime({
    storage: new SqliteActorStorage({ baseDir: dir }),
    actors: [Counter],
  });
  const key = `customer/path/${'long key '.repeat(8)}`;
  try {
    await runtime.get(Counter, key).read();
    expect((await runtime.listActors()).filter((a) => a.actorKey === key)).toHaveLength(1);
    await runtime.clear();
    runtime = new ActorRuntime({
      storage: new SqliteActorStorage({ baseDir: dir }),
      actors: [Counter],
    });
    const list = await runtime.listActors();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      actorId: `app:Counter:${key}`,
      actorKey: key,
      status: 'inactive',
      identityInferred: false,
    });
    mkdirSync(join(dir, 'app', 'Legacy'), { recursive: true });
    const legacy = new Database(join(dir, 'app', 'Legacy', 'display_1234567890abcdef.db'));
    legacy.run('CREATE TABLE legacy (value TEXT)');
    legacy.close();
    expect((await runtime.listActors()).find((a) => a.actorType === 'Legacy')).toMatchObject({
      actorKey: 'display',
      identityInferred: true,
    });
  } finally {
    await runtime.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('re-registering an actor replaces its constructor registration', async () => {
  @Actor({ name: 'Counter', namespace: 'app' })
  class First {
    read() {
      return 1;
    }
  }
  @Actor({ name: 'Counter', namespace: 'app' })
  class Second {
    read() {
      return 2;
    }
  }
  const runtime = new ActorRuntime({ actors: [First] });
  try {
    runtime.register(First);
    runtime.register(Second);
    expect(runtime.getRegisteredActors()).toHaveLength(1);
    expect(runtime.isRegistered(First)).toBe(false);
    expect(runtime.isRegistered(Second)).toBe(true);
    expect(await runtime.get(Second, 'key').read()).toBe(2);
    expect((await runtime.reload()).reloadedActors).toEqual(['Counter']);
  } finally {
    await runtime.clear();
  }
});

it('reload timeouts preserve running SQLite transactions and restore admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actor-reload-timeout-'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  @Actor()
  class Slow {
    @ActorContext() ctx!: ActorContext;
    async run() {
      await this.ctx.storage.set('value', 7);
      entered();
      await held;
      return 7;
    }
    async read() {
      return this.ctx.storage.get('value');
    }
  }
  const runtime = new ActorRuntime({
    storage: new SqliteActorStorage({ baseDir: dir }),
    actors: [Slow],
  });
  try {
    const ref = runtime.get(Slow, 'key');
    const running = ref.run();
    await started;
    await expect(runtime.reload({ policy: 'fail', timeoutMs: 1 })).rejects.toThrow(
      'drain timed out',
    );
    release();
    expect(await running).toBe(7);
    expect(await ref.read()).toBe(7);
    expect((await runtime.reload()).success).toBe(true);
  } finally {
    release();
    await runtime.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});
