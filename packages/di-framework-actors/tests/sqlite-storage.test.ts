import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Actor, ActorContext, ActorMethod, ActorRuntime, SqliteActorStorage } from '../src/index';

@Actor()
class BankAccountActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async deposit(amount: number): Promise<number> {
    const current = (await this.ctx.storage.get<number>('balance')) ?? 0;
    const updated = current + amount;
    await this.ctx.storage.set('balance', updated);
    return updated;
  }

  @ActorMethod()
  async getBalance(): Promise<number> {
    return (await this.ctx.storage.get<number>('balance')) ?? 0;
  }

  @ActorMethod()
  async failingTransfer(amount: number): Promise<void> {
    const current = (await this.ctx.storage.get<number>('balance')) ?? 0;
    await this.ctx.storage.set('balance', current + amount);
    // Deliberate error to trigger rollback
    throw new Error('Transfer aborted due to simulated network partition');
  }

  @ActorMethod()
  async setProfile(profile: { name: string; email: string }): Promise<void> {
    await this.ctx.storage.set('profile', profile);
  }

  @ActorMethod()
  async getProfile(): Promise<{ name: string; email: string } | undefined> {
    return await this.ctx.storage.get('profile');
  }

  @ActorMethod()
  async clearAllState(): Promise<void> {
    await this.ctx.storage.clear();
  }
}

describe('SqliteActorStorage Persistence and Transactions', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    cleanupDirs.length = 0;
  });

  it('supports direct storage operations and isolated transactions', async () => {
    const storage = SqliteActorStorage.temporary();

    try {
      const actorId = 'actor:test-1';

      // 1. Direct operations
      await storage.set(actorId, 'count', 10);
      expect(await storage.get<number>(actorId, 'count')).toBe(10);
      expect(await storage.has(actorId, 'count')).toBe(true);
      expect(await storage.keys(actorId)).toEqual(['count']);

      // 2. Transaction staging and rollback
      const tx1 = await storage.beginTransaction(actorId);
      expect(await tx1.get<number>('count')).toBe(10);
      await tx1.set('count', 99);
      await tx1.set('temp', 'stage-val');
      expect(await tx1.get<number>('count')).toBe(99);
      expect(await tx1.get<string>('temp')).toBe('stage-val');

      // Uncommitted state not visible in storage
      expect(await storage.get<number>(actorId, 'count')).toBe(10);
      expect(await storage.has(actorId, 'temp')).toBe(false);

      await tx1.rollback();
      expect(await storage.get<number>(actorId, 'count')).toBe(10);
      expect(await storage.has(actorId, 'temp')).toBe(false);

      // 3. Transaction staging and commit
      const tx2 = await storage.beginTransaction(actorId);
      await tx2.set('count', 42);
      await tx2.set('name', 'di-framework');
      await tx2.commit();

      expect(await storage.get<number>(actorId, 'count')).toBe(42);
      expect(await storage.get<string>(actorId, 'name')).toBe('di-framework');

      // 4. Transaction delete and clear
      const tx3 = await storage.beginTransaction(actorId);
      expect(await tx3.delete('name')).toBe(true);
      expect(await tx3.has('name')).toBe(false);
      await tx3.commit();
      expect(await storage.has(actorId, 'name')).toBe(false);

      const tx4 = await storage.beginTransaction(actorId);
      await tx4.clear();
      await tx4.commit();
      expect(await storage.keys(actorId)).toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it('survives explicit deactivation and process restart against the same directory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-persistence-'));
    cleanupDirs.push(tempDir);

    // Phase 1: Process / Runtime 1
    const storage1 = new SqliteActorStorage({ baseDir: tempDir });
    const runtime1 = new ActorRuntime({ storage: storage1 });
    runtime1.register(BankAccountActor);

    const account = runtime1.get(BankAccountActor, 'acc-100');
    expect(await account.deposit(250)).toBe(250);
    await account.setProfile({ name: 'Alice', email: 'alice@example.com' });
    expect(await account.getBalance()).toBe(250);

    // Explicit deactivation of actor instance
    const deactivated = await runtime1.deactivate(BankAccountActor, 'acc-100');
    expect(deactivated).toBe(true);

    // Reactivation within Runtime 1: state must survive deactivation!
    const reactivatedAccount = runtime1.get(BankAccountActor, 'acc-100');
    expect(await reactivatedAccount.getBalance()).toBe(250);
    expect(await reactivatedAccount.getProfile()).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
    });

    // Close Runtime 1 (simulating process exit)
    await runtime1.clear();
    await storage1.close();

    // Phase 2: Process / Runtime 2 restart against the same directory
    const storage2 = new SqliteActorStorage({ baseDir: tempDir });
    const runtime2 = new ActorRuntime({ storage: storage2 });
    runtime2.register(BankAccountActor);

    const restartedAccount = runtime2.get(BankAccountActor, 'acc-100');
    expect(await restartedAccount.getBalance()).toBe(250);
    expect(await restartedAccount.getProfile()).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
    });

    // Deposit more funds in restarted runtime
    expect(await restartedAccount.deposit(100)).toBe(350);
    expect(await restartedAccount.getBalance()).toBe(350);

    await runtime2.clear();
    await storage2.close();
  });

  it('ensures different actors have isolated state', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(BankAccountActor);

    try {
      const user1 = runtime.get(BankAccountActor, 'user-1');
      const user2 = runtime.get(BankAccountActor, 'user-2');
      const user3 = runtime.get(BankAccountActor, 'user-3');

      await user1.deposit(100);
      await user2.deposit(200);
      await user3.deposit(300);

      expect(await user1.getBalance()).toBe(100);
      expect(await user2.getBalance()).toBe(200);
      expect(await user3.getBalance()).toBe(300);

      // Verify each actor has separate files/state
      const dump1 = await storage.dump('BankAccountActor:user-1');
      const dump2 = await storage.dump('BankAccountActor:user-2');
      const dump3 = await storage.dump('BankAccountActor:user-3');

      expect(dump1).toEqual({ balance: 100 });
      expect(dump2).toEqual({ balance: 200 });
      expect(dump3).toEqual({ balance: 300 });
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('automatically commits on success and rolls back on failure (AC: commits, rollback, recovery)', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(BankAccountActor);

    try {
      const account = runtime.get(BankAccountActor, 'acc-rollback');
      await account.deposit(500);
      expect(await account.getBalance()).toBe(500);

      // Failing transfer attempts to add 200 then throws
      await expect(account.failingTransfer(200)).rejects.toThrow(
        'Transfer aborted due to simulated network partition',
      );

      // Balance MUST remain 500! Uncommitted state was never committed to SQLite
      expect(await account.getBalance()).toBe(500);

      // Direct check in underlying storage confirms 500
      expect(await storage.get<number>('BankAccountActor:acc-rollback', 'balance')).toBe(500);
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('enforces bounded connection caching and idle connection cleanup', async () => {
    // Storage configured with maxConnections = 3 and idleTimeoutMs = 50ms
    const storage = SqliteActorStorage.temporary({
      maxConnections: 3,
      idleTimeoutMs: 50,
    });

    try {
      // Access 3 actors to fill cache
      await storage.set('actor-1', 'key', 'v1');
      await storage.set('actor-2', 'key', 'v2');
      await storage.set('actor-3', 'key', 'v3');

      // Accessing a 4th actor must trigger LRU eviction of the oldest idle connection
      await storage.set('actor-4', 'key', 'v4');

      // All 4 actors still have valid persistent data when requested again
      expect(await storage.get<string>('actor-1', 'key')).toBe('v1');
      expect(await storage.get<string>('actor-2', 'key')).toBe('v2');
      expect(await storage.get<string>('actor-3', 'key')).toBe('v3');
      expect(await storage.get<string>('actor-4', 'key')).toBe('v4');

      // Wait for idle timeout and run cleanup
      await new Promise((resolve) => setTimeout(resolve, 80));
      const evicted = await storage.cleanupIdleConnections();
      expect(evicted).toBeGreaterThan(0);
    } finally {
      await storage.close();
    }
  });

  it('supports in-memory SQLite mode with the same adapter behavior', async () => {
    const storage = new SqliteActorStorage({ inMemory: true });
    const runtime = new ActorRuntime({ storage });
    runtime.register(BankAccountActor);

    try {
      const account = runtime.get(BankAccountActor, 'mem-acc-1');
      await account.deposit(1000);
      expect(await account.getBalance()).toBe(1000);

      // Deactivate and reactivate in memory
      await runtime.deactivate(BankAccountActor, 'mem-acc-1');
      const reactivated = runtime.get(BankAccountActor, 'mem-acc-1');
      expect(await reactivated.getBalance()).toBe(1000);
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });
});

it('rejects undefined and lists staged SQLite changes consistently', async () => {
  const storage = SqliteActorStorage.temporary({ idleTimeoutMs: 0 });
  const id = 'Listed:key';
  try {
    await expect(storage.set(id, 'invalid', undefined)).rejects.toThrow('undefined');
    expect(await storage.has(id, 'invalid')).toBe(false);
    await storage.set(id, 'keep', { n: 1 });
    await storage.set(id, 'remove', 2);
    const tx = await storage.beginTransaction(id);
    await expect(tx.set('invalid', undefined)).rejects.toThrow('undefined');
    await tx.delete('remove');
    await tx.set('new', 3);
    expect(await tx.keys()).toEqual(['keep', 'new']);
    expect(await tx.entries()).toEqual([
      ['keep', { n: 1 }],
      ['new', 3],
    ]);
    expect(await tx.has('keep')).toBe(true);
    expect(await tx.has('remove')).toBe(false);
    await tx.commit();
    expect(await storage.dump(id)).toEqual({ keep: { n: 1 }, new: 3 });
    const clear = await storage.beginTransaction(id);
    await clear.clear();
    expect(await clear.keys()).toEqual([]);
    expect(await clear.has('keep')).toBe(false);
    await clear.set('replacement', null);
    await clear.commit();
    expect(await storage.entries(id)).toEqual([['replacement', null]]);
    const native = await storage.beginTransaction(id);
    expect((native as any).getDatabase()).toBe(await storage.getDatabase(id));
    await native.rollback();
    await storage.clearAll();
    expect(await storage.dump(id)).toEqual({});
  } finally {
    await storage.close();
  }
  await expect(storage.get(id, 'keep')).rejects.toThrow('closed');
  expect(await storage.cleanupIdleConnections()).toBe(0);
});

it('deletes direct SQLite state and preserves timer cleanup behavior', async () => {
  const storage = SqliteActorStorage.temporary({ idleTimeoutMs: 1 });
  try {
    await storage.set('Timer:key', 'value', 1);
    expect(await storage.delete('Timer:key', 'value')).toBe(true);
    expect(await storage.delete('Timer:key', 'missing')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect((storage as any).connections.size).toBe(0);
  } finally {
    await storage.close();
  }
});

it('preserves private in-memory databases across cache eviction and actor deactivation', async () => {
  const storage = new SqliteActorStorage({ inMemory: true, maxConnections: 1, idleTimeoutMs: 1 });
  const isolated = new SqliteActorStorage({ inMemory: true });
  try {
    await storage.set('Counter:first', 'count', 7);
    await storage.set('Counter:second', 'count', 9);
    expect(await storage.get<number>('Counter:first', 'count')).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await storage.cleanupIdleConnections()).toBe(1);
    expect(await storage.get<number>('Counter:first', 'count')).toBe(7);
    await storage.closeActor('Counter:first');
    expect(await storage.get<number>('Counter:first', 'count')).toBe(7);
    expect(await isolated.get('Counter:first', 'count')).toBeUndefined();
  } finally {
    await storage.close();
    await isolated.close();
  }
});
