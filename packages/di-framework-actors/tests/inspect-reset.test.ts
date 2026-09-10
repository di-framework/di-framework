import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Actor,
  ActorContext,
  ActorDevManager,
  ActorMethod,
  ActorRuntime,
  SqliteActorStorage,
} from '../src/index';

describe('Actor Inspection and Scoped Reset Tooling', () => {
  let tmpDir: string;
  let storage: SqliteActorStorage;
  let runtime: ActorRuntime;
  let devManager: ActorDevManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-inspect-test-'));
    storage = new SqliteActorStorage({ baseDir: tmpDir });
    runtime = new ActorRuntime({ storage, namespace: 'demo' });
    devManager = new ActorDevManager({ runtime, baseDir: tmpDir, namespace: 'demo' });
  });

  afterEach(async () => {
    await runtime.clear();
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  @Actor()
  class UserActor {
    @ActorContext()
    ctx!: ActorContext;

    @ActorMethod()
    async setSecret(secret: string): Promise<void> {
      await this.ctx.storage.set('secretKey', secret);
      await this.ctx.storage.set('loginCount', 1);
    }

    @ActorMethod()
    async getLoginCount(): Promise<number> {
      return (await this.ctx.storage.get('loginCount')) ?? 0;
    }
  }

  it('inspects active actor without dumping private state by default', async () => {
    runtime.register(UserActor);
    const user = runtime.get(UserActor, 'u-123');
    await user.setSecret('super-confidential-token');

    // Inspect via runtime
    const info = await runtime.inspect(UserActor, 'u-123');
    expect(info).not.toBeNull();
    expect(info?.actorId).toBe('demo:UserActor:u-123');
    expect(info?.actorType).toBe('UserActor');
    expect(info?.actorKey).toBe('u-123');
    expect(info?.status).toBe('active');
    expect(info?.runningCalls).toBe(0);
    expect(info?.pendingCalls).toBe(0);
    expect(info?.methods).toContain('setSecret');
    expect(info?.methods).toContain('getLoginCount');
    expect(info?.storagePath).toBeDefined();

    // CRITICAL: Private state must NOT be dumped by default
    expect(info?.state).toBeUndefined();

    // When showState: true is explicitly requested, private state is included
    const withState = await runtime.inspect(UserActor, 'u-123', { showState: true });
    expect(withState?.state).toBeDefined();
    expect(withState?.state?.secretKey).toBe('super-confidential-token');
    expect(withState?.state?.loginCount).toBe(1);
  });

  it('lists active and persisted actors with call counts and status', async () => {
    runtime.register(UserActor);

    const user1 = runtime.get(UserActor, 'u-1');
    const user2 = runtime.get(UserActor, 'u-2');
    await user1.setSecret('s1');
    await user2.setSecret('s2');

    // Deactivate u-2 so it is inactive on disk
    await runtime.deactivate(UserActor, 'u-2');

    const list = await devManager.list();
    expect(list.length).toBeGreaterThanOrEqual(2);

    const activeUser = list.find((a) => a.actorKey === 'u-1');
    expect(activeUser?.status).toBe('active');

    const inactiveUser = list.find((a) => a.actorKey === 'u-2');
    expect(inactiveUser?.status).toBe('inactive');
  });

  it('startup and reload never delete persistent state automatically', async () => {
    runtime.register(UserActor);
    const user = runtime.get(UserActor, 'persist-test');
    await user.setSecret('persisted-val');

    // Reload runtime multiple times
    await runtime.reload();
    await runtime.reload();

    // Verify state is completely preserved
    expect(runtime.get(UserActor, 'persist-test').actorKey).toBe('persist-test');
    const state = await runtime.inspect(UserActor, 'persist-test', { showState: true });
    expect(state?.state?.secretKey).toBe('persisted-val');

    // Deactivate / clear old runtime to release locks before fresh runtime opens it
    await runtime.clear();

    // Fresh runtime against the same storage directory
    const freshRuntime = new ActorRuntime({
      storage: new SqliteActorStorage({ baseDir: tmpDir }),
      namespace: 'demo',
    });
    freshRuntime.register(UserActor);

    const freshRef = freshRuntime.get(UserActor, 'persist-test');
    expect(await freshRef.getLoginCount()).toBe(1);
    await freshRuntime.clear();
  });

  it('enforces explicit scoped reset and deletes only requested scope', async () => {
    runtime.register(UserActor);
    const u1 = runtime.get(UserActor, 'user-one');
    const u2 = runtime.get(UserActor, 'user-two');

    await u1.setSecret('secret-1');
    await u2.setSecret('secret-2');

    // Calling reset without scope must throw
    expect(() => runtime.reset({})).toThrow();

    // Scoped reset of user-one only
    const resetRes = await devManager.reset({
      actorName: 'UserActor',
      actorKey: 'user-one',
    });
    expect(resetRes.success).toBe(true);

    // user-one state is gone
    const inspectU1 = await runtime.inspect(UserActor, 'user-one', { showState: true });
    expect(inspectU1?.state?.secretKey).toBeUndefined();

    // user-two state is preserved intact!
    const inspectU2 = await runtime.inspect(UserActor, 'user-two', { showState: true });
    expect(inspectU2?.state?.secretKey).toBe('secret-2');

    // Scoped reset of entire namespace
    const resetNs = await runtime.reset({ namespace: 'demo' });
    expect(resetNs.success).toBe(true);

    const inspectU2After = await runtime.inspect(UserActor, 'user-two', { showState: true });
    expect(inspectU2After?.state?.secretKey).toBeUndefined();
  });
});
