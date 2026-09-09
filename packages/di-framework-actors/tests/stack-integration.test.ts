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
