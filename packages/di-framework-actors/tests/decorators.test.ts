import { describe, expect, it } from 'bun:test';
import { Actor, ActorContext, ActorMethod, ActorRuntime } from '../src/index';

// Test variations of @Actor decorator syntax
@Actor
class BareActor {
  @ActorMethod
  async greet(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}

@Actor('CustomNamedActor')
class CustomNameActor {
  @ActorMethod({ name: 'customEcho' })
  async echo(msg: string): Promise<string> {
    return msg;
  }
}

@Actor({ name: 'ConfiguredActor' })
class ConfiguredActor {
  @ActorContext()
  private ctxWithParens!: ActorContext;

  @ActorMethod({ timeout: 50 })
  async slowMethod(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return 'done';
  }

  @ActorMethod()
  async inspectContext(): Promise<{ actorId: string; actorKey: string; hasStorage: boolean }> {
    return {
      actorId: this.ctxWithParens.actorId,
      actorKey: this.ctxWithParens.actorKey,
      hasStorage: !!this.ctxWithParens.storage,
    };
  }
}

@Actor()
class ParamInjectedActor {
  @ActorMethod()
  async checkParamInjection(@ActorContext ctx: ActorContext, prefix: string): Promise<string> {
    return `${prefix}:${ctx.actorKey}`;
  }

  @ActorMethod()
  async checkStaticCurrent(): Promise<string> {
    const current = ActorContext.current();
    if (!current) throw new Error('No current context found');
    return current.actorKey;
  }
}

describe('Actor Decorators and Context Injection', () => {
  it('supports bare @Actor and @ActorMethod without parens', async () => {
    const runtime = new ActorRuntime();
    runtime.register(BareActor);

    const ref = runtime.get(BareActor, 'b1');
    const msg = await ref.greet('World');
    expect(msg).toBe('Hello, World!');
  });

  it('supports custom actor names and custom method names', async () => {
    const runtime = new ActorRuntime();
    runtime.register(CustomNameActor);

    // Can resolve by class or custom name
    const refByClass = runtime.get(CustomNameActor, 'c1');
    expect(refByClass.actorType).toBe('CustomNamedActor');

    const refByName = runtime.get('CustomNamedActor', 'c1');
    expect(refByName.actorType).toBe('CustomNamedActor');

    // Invoking custom method name
    const res = await (refByClass as any).customEcho('test message');
    expect(res).toBe('test message');
  });

  it('supports @ActorContext() property injection and verifies ActorContext structure', async () => {
    const runtime = new ActorRuntime();
    runtime.register(ConfiguredActor);

    const ref = runtime.get(ConfiguredActor, 'cfg-1');
    const info = await ref.inspectContext();

    expect(info.actorKey).toBe('cfg-1');
    expect(info.actorId).toBe('ConfiguredActor:cfg-1');
    expect(info.hasStorage).toBe(true);
  });

  it('supports method parameter injection with @ActorContext', async () => {
    const runtime = new ActorRuntime();
    runtime.register(ParamInjectedActor);

    const ref = runtime.get(ParamInjectedActor, 'param-key');
    const res = await ref.checkParamInjection(undefined as any, 'Key');
    expect(res).toBe('Key:param-key');
  });

  it('supports ActorContext.current() via AsyncLocalStorage', async () => {
    const runtime = new ActorRuntime();
    runtime.register(ParamInjectedActor);

    const ref = runtime.get(ParamInjectedActor, 'static-ctx-key');
    const key = await ref.checkStaticCurrent();
    expect(key).toBe('static-ctx-key');
  });

  it('enforces method timeouts configured on @ActorMethod', async () => {
    const runtime = new ActorRuntime();
    runtime.register(ConfiguredActor);

    const ref = runtime.get(ConfiguredActor, 'timeout-test');
    await expect(ref.slowMethod()).rejects.toThrow('timed out');
  });
});
