import { beforeEach, describe, expect, it } from 'bun:test';
import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorMethodNotFoundError,
  ActorNotRegisteredError,
  actors,
} from '../src/index';

@Actor()
class CounterActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async increment(step: number = 1): Promise<number> {
    const current = (await this.ctx.storage.get<number>('count')) ?? 0;
    const next = current + step;
    await this.ctx.storage.set('count', next);
    return next;
  }

  @ActorMethod()
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  @ActorMethod()
  async reset(): Promise<void> {
    await this.ctx.storage.delete('count');
  }

  // Non-actor method: should not be exposed via actor proxy
  internalHelper(): string {
    return 'secret';
  }
}

@Actor()
class CallerActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async callCounter(targetKey: string, step: number): Promise<number> {
    const counterRef = this.ctx.actors.get(CounterActor, targetKey);
    return await counterRef.increment(step);
  }
}

@Actor()
class FailingActor {
  @ActorMethod()
  async fail(): Promise<void> {
    throw new Error('Planned failure');
  }
}

describe('Actors runtime and typed references', () => {
  beforeEach(async () => {
    await actors.clear();
  });

  it('registers actor class and resolves typed reference', async () => {
    actors.register(CounterActor);
    const counter = actors.get(CounterActor, 'c1');

    expect(counter.actorKey).toBe('c1');
    expect(counter.actorType).toBe('CounterActor');
    expect(counter.id).toBe('CounterActor:c1');

    const result = await counter.increment(5);
    expect(result).toBe(5);

    const count = await counter.getCount();
    expect(count).toBe(5);

    await counter.reset();
    expect(await counter.getCount()).toBe(0);
  });

  it('supports cross-actor invocations via context.actors', async () => {
    actors.register(CounterActor);
    actors.register(CallerActor);

    const caller = actors.get(CallerActor, 'caller-1');
    const result = await caller.callCounter('shared-counter', 10);
    expect(result).toBe(10);

    const counter = actors.get(CounterActor, 'shared-counter');
    expect(await counter.getCount()).toBe(10);
  });

  it('propagates error when actor method throws', async () => {
    actors.register(FailingActor);
    const ref = actors.get(FailingActor, 'f1');

    await expect(ref.fail()).rejects.toThrow('Planned failure');
  });

  it('throws ActorMethodNotFoundError when invoking non-existent or unexposed method', async () => {
    actors.register(CounterActor);
    const ref = actors.get(CounterActor, 'c1') as any;

    await expect(ref.nonExistentMethod()).rejects.toThrow(ActorMethodNotFoundError);
    await expect(ref.internalHelper()).rejects.toThrow(ActorMethodNotFoundError);
  });

  it('throws ActorNotRegisteredError when obtaining reference to unregistered actor', () => {
    class UnregisteredActor {}

    expect(() => actors.get(UnregisteredActor as any, 'key1')).toThrow(ActorNotRegisteredError);
  });
});
