import { describe, expect, it } from 'bun:test';
import { ActorContext, ActorRuntime } from '../src/index.js';

// Plain classes without decorators for explicit unit test registration
class PlainActorA {
  async compute(a: number, b: number): Promise<number> {
    return a + b;
  }
}

class PlainActorB {
  async shout(text: string): Promise<string> {
    return text.toUpperCase();
  }
}

class LifecycleActor {
  activated = false;
  deactivated = false;

  async onActivate(): Promise<void> {
    this.activated = true;
  }

  async onDeactivate(): Promise<void> {
    this.deactivated = true;
  }

  async checkStatus(): Promise<{ activated: boolean; deactivated: boolean }> {
    return { activated: this.activated, deactivated: this.deactivated };
  }
}

describe('Explicit Class Registration Harness for Unit Tests', () => {
  it('registers plain classes without build-time discovery or decorators', async () => {
    const runtime = new ActorRuntime();
    runtime.register(PlainActorA);
    runtime.register(PlainActorB);

    expect(runtime.isRegistered(PlainActorA)).toBe(true);
    expect(runtime.isRegistered(PlainActorB)).toBe(true);
    expect(runtime.isRegistered('PlainActorA')).toBe(true);

    const refA = runtime.get(PlainActorA, 'a-1');
    const refB = runtime.get(PlainActorB, 'b-1');

    expect(await refA.compute(10, 20)).toBe(30);
    expect(await refB.shout('hello')).toBe('HELLO');
  });

  it('supports registration via constructor options and batch arrays', async () => {
    const runtime = new ActorRuntime({
      actors: [PlainActorA],
    });
    expect(runtime.isRegistered(PlainActorA)).toBe(true);

    runtime.register([PlainActorB]);
    expect(runtime.isRegistered(PlainActorB)).toBe(true);

    const list = runtime.getRegisteredActors();
    expect(list.length).toBe(2);
    expect(list.map((r) => r.name)).toContain('PlainActorA');
    expect(list.map((r) => r.name)).toContain('PlainActorB');
  });

  it('isolates state and actors across multiple ActorRuntime instances', async () => {
    const runtime1 = new ActorRuntime();
    const runtime2 = new ActorRuntime();

    runtime1.register(PlainActorA);
    // runtime2 does not have PlainActorA registered
    expect(runtime1.isRegistered(PlainActorA)).toBe(true);
    expect(runtime2.isRegistered(PlainActorA)).toBe(false);
  });

  it('triggers onActivate and onDeactivate lifecycle hooks', async () => {
    const runtime = new ActorRuntime();
    runtime.register(LifecycleActor);

    const ref = runtime.get(LifecycleActor, 'life-1');
    // First invocation activates the instance
    const statusBefore = await ref.checkStatus();
    expect(statusBefore.activated).toBe(true);
    expect(statusBefore.deactivated).toBe(false);

    // Deactivate instance
    const deactivated = await runtime.deactivate(LifecycleActor, 'life-1');
    expect(deactivated).toBe(true);

    // Deactivating again returns false (not active)
    const deactivatedAgain = await runtime.deactivate(LifecycleActor, 'life-1');
    expect(deactivatedAgain).toBe(false);
  });
});
