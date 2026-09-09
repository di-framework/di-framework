import { describe, expect, it } from 'bun:test';
import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorRuntime,
  InMemoryActorStorage,
} from '../src/index.js';

@Actor()
class TransactionalActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async updateState(key: string, value: any): Promise<void> {
    await this.ctx.storage.set(key, value);
  }

  @ActorMethod()
  async getState(key: string): Promise<any> {
    return await this.ctx.storage.get(key);
  }

  @ActorMethod()
  async riskyTransfer(amount: number, failAfterMutation: boolean): Promise<void> {
    const current = (await this.ctx.storage.get<number>('balance')) ?? 100;
    // Mutate state during invocation
    await this.ctx.storage.set('balance', current + amount);

    if (failAfterMutation) {
      throw new Error('Transaction aborted midway');
    }
  }
}

describe('Transactional In-Memory Storage', () => {
  it('supports direct storage operations and transactions', async () => {
    const storage = new InMemoryActorStorage();
    const actorId = 'test-actor-1';

    // Direct operations
    await storage.set(actorId, 'k1', 'val1');
    expect(await storage.get<string>(actorId, 'k1')).toBe('val1');
    expect(await storage.has(actorId, 'k1')).toBe(true);
    expect(await storage.keys(actorId)).toEqual(['k1']);

    // Begin transaction
    const tx = await storage.beginTransaction(actorId);
    expect(await tx.get<string>('k1')).toBe('val1');

    // Stage changes in transaction
    await tx.set('k1', 'modified-in-tx');
    await tx.set('k2', 'new-in-tx');

    // Inside transaction, changes are visible
    expect(await tx.get<string>('k1')).toBe('modified-in-tx');
    expect(await tx.get<string>('k2')).toBe('new-in-tx');
    expect(await tx.has('k2')).toBe(true);

    // Outside transaction, committed state is untouched
    expect(await storage.get<string>(actorId, 'k1')).toBe('val1');
    expect(await storage.get<string>(actorId, 'k2')).toBeUndefined();

    // Rollback discards staged mutations
    await tx.rollback();
    expect(await storage.get<string>(actorId, 'k1')).toBe('val1');
    expect(await storage.get<string>(actorId, 'k2')).toBeUndefined();

    // New transaction that commits
    const tx2 = await storage.beginTransaction(actorId);
    await tx2.set('k1', 'committed-val');
    await tx2.delete('k1');
    expect(await tx2.has('k1')).toBe(false);
    expect(await tx2.get<string>('k1')).toBeUndefined();
    await tx2.set('k3', 'val3');
    await tx2.commit();

    expect(await storage.has(actorId, 'k1')).toBe(false);
    expect(await storage.get<string>(actorId, 'k3')).toBe('val3');
  });

  it('automatically commits storage state on successful actor invocation', async () => {
    const storage = new InMemoryActorStorage();
    const runtime = new ActorRuntime({ storage });
    runtime.register(TransactionalActor);

    const actor = runtime.get(TransactionalActor, 'acc-1');
    await actor.riskyTransfer(50, false);

    expect(await actor.getState('balance')).toBe(150);
    // Verify in underlying storage directly
    expect(await storage.get<number>('TransactionalActor:acc-1', 'balance')).toBe(150);
  });

  it('automatically rolls back storage state when actor invocation throws an error', async () => {
    const storage = new InMemoryActorStorage();
    const runtime = new ActorRuntime({ storage });
    runtime.register(TransactionalActor);

    const actor = runtime.get(TransactionalActor, 'acc-2');
    // Set initial balance to 100
    await actor.updateState('balance', 100);
    expect(await actor.getState('balance')).toBe(100);

    // Attempt transfer that mutates balance to 150 but then throws an error
    await expect(actor.riskyTransfer(50, true)).rejects.toThrow('Transaction aborted midway');

    // Balance MUST still be 100, not 150!
    expect(await actor.getState('balance')).toBe(100);
    expect(await storage.get<number>('TransactionalActor:acc-2', 'balance')).toBe(100);
  });
});
