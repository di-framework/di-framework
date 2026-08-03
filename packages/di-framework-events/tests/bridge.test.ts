import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';
import { memoryTransport } from '../src/adapters/memory.ts';
import { createEventBridge, unwrapPublisherPayload } from '../src/bridge.ts';
import { JsonCodec } from '../src/codec.ts';
import type { Ack, EventMessage } from '../src/types.ts';

beforeEach(() => {
  useContainer().clear();
});

describe('unwrapPublisherPayload', () => {
  it('unwraps @Publisher envelopes to result', () => {
    expect(
      unwrapPublisherPayload({
        className: 'S',
        methodName: 'm',
        result: { id: 1 },
      }),
    ).toEqual({ id: 1 });
  });

  it('passes through plain payloads', () => {
    expect(unwrapPublisherPayload({ id: 2 })).toEqual({ id: 2 });
    expect(unwrapPublisherPayload('x')).toBe('x');
  });
});

describe('JsonCodec', () => {
  it('round-trips values', () => {
    expect(JsonCodec.decode(JsonCodec.encode({ a: 1 }))).toEqual({ a: 1 });
    expect(JsonCodec.decode(JsonCodec.encode(null))).toBeNull();
  });
});

describe('createEventBridge + memoryTransport', () => {
  it('publishes outbound container events to the transport topic', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];

    await transport.start?.();
    await transport.subscribe('orders', async (msg, ack) => {
      seen.push(msg.payload);
      await ack.ack();
    });

    const bridge = createEventBridge({
      transport,
      routes: {
        outbound: [{ event: 'order.placed', topic: 'orders' }],
      },
    });
    await bridge.start();

    useContainer().emit('order.placed', {
      className: 'OrderService',
      methodName: 'place',
      result: { id: 'o1' },
    });

    // outbound publish is async
    await Bun.sleep(10);

    expect(seen).toEqual([{ id: 'o1' }]);
    await bridge.stop();
  });

  it('emits inbound transport messages onto the container bus', async () => {
    const transport = memoryTransport();
    const received: unknown[] = [];

    useContainer().on('payment.captured', (payload) => {
      received.push(payload);
    });

    const bridge = createEventBridge({
      transport,
      routes: {
        inbound: [{ topic: 'payments', event: 'payment.captured' }],
      },
    });
    await bridge.start();

    await transport.publish({
      id: '1',
      topic: 'payments',
      payload: { amount: 42 },
    });

    await Bun.sleep(10);
    expect(received).toEqual([{ amount: 42 }]);
    await bridge.stop();
  });

  it('does not loop when outbound and inbound share the same event/topic', async () => {
    const transport = memoryTransport();
    let publishes = 0;

    const counting = {
      ...transport,
      async publish(msg: EventMessage) {
        publishes += 1;
        return transport.publish(msg);
      },
      async subscribe(topic: string, handler: (msg: EventMessage, ack: Ack) => Promise<void>) {
        return transport.subscribe(topic, handler);
      },
      start: () => transport.start?.() ?? Promise.resolve(),
      stop: () => transport.stop?.() ?? Promise.resolve(),
    };

    const bridge = createEventBridge({
      transport: counting,
      routes: {
        outbound: [{ event: 'echo', topic: 'echo' }],
        inbound: [{ topic: 'echo', event: 'echo' }],
      },
    });
    await bridge.start();

    useContainer().emit('echo', { className: 'T', methodName: 'm', result: { n: 1 } });
    await Bun.sleep(20);

    expect(publishes).toBe(1);
    await bridge.stop();
  });

  it('stops on container.clear()', async () => {
    const transport = memoryTransport();
    const bridge = createEventBridge({
      transport,
      routes: { outbound: [{ event: 'x', topic: 'x' }] },
    });
    await bridge.start();
    expect(bridge.started).toBe(true);

    useContainer().clear();
    await Bun.sleep(10);
    expect(bridge.started).toBe(false);
  });

  it('end-to-end with @Publisher and @Subscriber', async () => {
    const received: unknown[] = [];

    @Container()
    class Audit {
      @Subscriber('order.placed')
      onPlaced(payload: unknown) {
        received.push(payload);
      }
    }

    @Container()
    class Orders {
      @Publisher('order.placed')
      place(id: string) {
        return { id };
      }
    }

    const transport = memoryTransport();
    const remote: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('orders', async (msg, ack) => {
      remote.push(msg.payload);
      await ack.ack();
    });

    const bridge = createEventBridge({
      transport,
      routes: {
        outbound: [{ event: 'order.placed', topic: 'orders' }],
      },
    });
    await bridge.start();

    const c = useContainer();
    c.resolve(Audit);
    const orders = c.resolve(Orders);
    orders.place('o9');

    await Bun.sleep(20);

    expect(received.length).toBe(1);
    expect((received[0] as { result: unknown }).result).toEqual({ id: 'o9' });
    expect(remote).toEqual([{ id: 'o9' }]);

    await bridge.stop();
  });
});
