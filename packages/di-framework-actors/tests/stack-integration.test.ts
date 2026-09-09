import { expect, it } from 'bun:test';
import { Actor, ActorRpcDispatcher, ActorRuntime } from '../src/index';

it('preserves namespace routing, request options, ownership and inspection across actor layers', async () => {
  @Actor({ name: 'Shared', namespace: 'one' })
  class First {
    count = 0;
    increment() {
      return ++this.count;
    }
  }
  @Actor({ name: 'Shared', namespace: 'two' })
  class Second {
    count = 10;
    increment() {
      return ++this.count;
    }
  }
  const requests: any[] = [];
  const runtime = new ActorRuntime({
    actors: [First, Second],
    ownerId: 'host',
    authorizationPolicy: {
      authorize(request) {
        requests.push(request);
        return true;
      },
    },
  });
  try {
    const ref = runtime.get<{ increment(): number }>('Shared', 'key', {
      namespace: 'two',
      requestId: 'same',
    });
    expect(await ref.increment()).toBe(11);
    expect(await ref.increment()).toBe(11);
    expect(requests[0].namespace).toBe('two');
    expect(await runtime.getActorOwnership('Shared', 'key', { namespace: 'two' })).toMatchObject({
      ownerId: 'host',
    });
    const dispatcher = new ActorRpcDispatcher(runtime);
    expect(
      await dispatcher.dispatch({
        requestId: 'rpc',
        namespace: 'one',
        actorType: 'Shared',
        actorKey: 'key',
        method: 'increment',
        args: [],
      }),
    ).toMatchObject({ success: true, result: 1 });
    expect(await runtime.inspect('two:Shared', 'key')).toMatchObject({
      status: 'active',
      pendingCalls: 0,
      runningCalls: 0,
    });
    expect((await runtime.reload({ namespace: 'two' })).success).toBe(true);
  } finally {
    await runtime.clear();
  }
});

it('enforces synchronous and asynchronous authorization before local execution', async () => {
  let calls = 0;
  @Actor()
  class Protected {
    run() {
      calls++;
      return calls;
    }
  }
  const policies = [
    () => false,
    async () => false,
    async () => {
      throw new Error('policy unavailable');
    },
  ];
  for (const authorize of policies) {
    const runtime = new ActorRuntime({ actors: [Protected], authorizationPolicy: { authorize } });
    try {
      await expect(runtime.get(Protected, 'key').run()).rejects.toBeInstanceOf(Error);
      expect(calls).toBe(0);
      expect(await runtime.listActors()).toEqual([]);
    } finally {
      await runtime.clear();
    }
  }
  const runtime = new ActorRuntime({
    actors: [Protected],
    authorizationPolicy: { authorize: async () => true },
  });
  try {
    expect(await runtime.get(Protected, 'key').run()).toBe(1);
  } finally {
    await runtime.clear();
  }
});
