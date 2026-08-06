import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';
import { memoryTransport } from '../src/adapters/memory.ts';
import { createEventBridge, unwrapPublisherPayload } from '../src/bridge.ts';
import { bytesFromCodecOutput, JsonCodec, stringFromCodecOutput } from '../src/codec.ts';
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

  it('decodes empty text to null and decodes Uint8Array input', () => {
    expect(JsonCodec.decode('')).toBeNull();
    expect(JsonCodec.decode(new TextEncoder().encode('{"a":2}'))).toEqual({ a: 2 });
  });
});

describe('codec byte/string helpers', () => {
  it('bytesFromCodecOutput passes through Uint8Array and encodes strings', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(bytesFromCodecOutput(bytes)).toBe(bytes);
    expect(bytesFromCodecOutput('hi')).toEqual(new TextEncoder().encode('hi'));
  });

  it('stringFromCodecOutput passes through strings and decodes Uint8Array', () => {
    expect(stringFromCodecOutput('hi')).toBe('hi');
    expect(stringFromCodecOutput(new TextEncoder().encode('hi'))).toBe('hi');
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

describe('createEventBridge - error handling & filters', () => {
  it('uses the default onError (console.error) when publish fails outbound', async () => {
    const transport = memoryTransport();
    const failing = {
      ...transport,
      publish: async () => {
        throw new Error('publish failed');
      },
    };
    const errorSpy = mock(() => {});
    const original = console.error;
    console.error = errorSpy;

    const bridge = createEventBridge({
      transport: failing,
      routes: { outbound: [{ event: 'oops', topic: 't' }] },
    });
    await bridge.start();

    useContainer().emit('oops', { x: 1 });
    await Bun.sleep(10);

    expect(errorSpy).toHaveBeenCalled();
    console.error = original;
    await bridge.stop();
  });

  it('calls a custom onError for outbound publish failures', async () => {
    const transport = memoryTransport();
    const failing = {
      ...transport,
      publish: async () => {
        throw new Error('publish failed');
      },
    };
    const errors: Array<{ direction: string; topic: string; event: string }> = [];

    const bridge = createEventBridge({
      transport: failing,
      routes: { outbound: [{ event: 'oops2', topic: 't2' }] },
      onError: (ctx) => {
        errors.push({ direction: ctx.direction, topic: ctx.topic, event: ctx.event });
      },
    });
    await bridge.start();

    useContainer().emit('oops2', { x: 1 });
    await Bun.sleep(10);

    expect(errors).toEqual([{ direction: 'outbound', topic: 't2', event: 'oops2' }]);
    await bridge.stop();
  });

  it('skips outbound publish when the outbound filter rejects the payload', async () => {
    const transport = memoryTransport();
    const published: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('filtered', async (msg, ack) => {
      published.push(msg.payload);
      await ack.ack();
    });

    const bridge = createEventBridge({
      transport,
      routes: {
        outbound: [
          {
            event: 'maybe',
            topic: 'filtered',
            filter: (payload) => (payload as { ok: boolean }).ok,
          },
        ],
      },
    });
    await bridge.start();

    useContainer().emit('maybe', { ok: false });
    await Bun.sleep(10);
    expect(published).toEqual([]);

    useContainer().emit('maybe', { ok: true });
    await Bun.sleep(10);
    expect(published).toEqual([{ ok: true }]);

    await bridge.stop();
  });

  it('acks (without emitting) when the inbound filter rejects the message', async () => {
    const transport = memoryTransport();
    const emitted: unknown[] = [];
    useContainer().on('filtered.in', (p) => emitted.push(p));

    const bridge = createEventBridge({
      transport,
      routes: {
        inbound: [
          {
            topic: 'in-topic',
            event: 'filtered.in',
            filter: (payload) => (payload as { keep: boolean }).keep,
          },
        ],
      },
    });
    await bridge.start();
    await transport.start?.();

    await transport.publish({ id: '1', topic: 'in-topic', payload: { keep: false } });
    await Bun.sleep(10);
    expect(emitted).toEqual([]);

    await transport.publish({ id: '2', topic: 'in-topic', payload: { keep: true } });
    await Bun.sleep(10);
    expect(emitted).toEqual([{ keep: true }]);

    await bridge.stop();
  });

  it('reports inbound handling errors via onError and nacks when route.map() throws', async () => {
    const transport = memoryTransport();
    const errors: Array<{ direction: string; error: unknown }> = [];

    const bridge = createEventBridge({
      transport,
      routes: {
        inbound: [
          {
            topic: 'boom-topic',
            event: 'boom.in',
            map: () => {
              throw new Error('map exploded');
            },
          },
        ],
      },
      onError: (ctx) => errors.push({ direction: ctx.direction, error: ctx.error }),
    });
    await bridge.start();
    await transport.start?.();

    await transport.publish({ id: '1', topic: 'boom-topic', payload: {} });
    await Bun.sleep(10);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.direction).toBe('inbound');
    expect((errors[0]?.error as Error).message).toBe('map exploded');

    await bridge.stop();
  });

  it('reports a second onError when ack.nack() itself throws during inbound error handling', async () => {
    const errors: Array<{ direction: string; error: unknown }> = [];

    let subscribedHandler:
      | ((msg: EventMessage, ack: Ack) => Promise<void>)
      | undefined;
    const transport = {
      async start() {},
      async stop() {},
      async publish() {},
      async subscribe(_topic: string, handler: (msg: EventMessage, ack: Ack) => Promise<void>) {
        subscribedHandler = handler;
        return () => {};
      },
    };

    const bridge = createEventBridge({
      transport,
      routes: {
        inbound: [
          {
            topic: 'boom-topic2',
            event: 'boom.in2',
            map: () => {
              throw new Error('map exploded');
            },
          },
        ],
      },
      onError: (ctx) => errors.push({ direction: ctx.direction, error: ctx.error }),
    });
    await bridge.start();

    const failingAck: Ack = {
      ack() {},
      nack() {
        throw new Error('nack failed too');
      },
    };
    await subscribedHandler?.(
      { id: '1', topic: 'boom-topic2', payload: {} },
      failingAck,
    );

    expect(errors).toHaveLength(2);
    expect((errors[0]?.error as Error).message).toBe('map exploded');
    expect((errors[1]?.error as Error).message).toBe('nack failed too');

    await bridge.stop();
  });
});
