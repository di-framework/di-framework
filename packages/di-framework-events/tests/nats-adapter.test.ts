import { describe, expect, it, mock } from 'bun:test';
import {
  type NatsConnectionLike,
  type NatsHeadersLike,
  type NatsJetStreamLike,
  type NatsLike,
  type NatsMsgLike,
  type NatsSubscriptionLike,
  natsTransport,
} from '../src/adapters/nats.ts';
import type { EventMessage } from '../src/types.ts';

function makeHeaders(): NatsHeadersLike {
  const map = new Map<string, string>();
  return {
    set(k: string, v: string) {
      map.set(k, v);
    },
    keys() {
      return map.keys();
    },
    get(k: string) {
      return map.get(k) ?? '';
    },
  };
}

describe('natsTransport - module load failure', () => {
  it('wraps dynamic import failure with an install hint', async () => {
    mock.module('nats', () => {
      throw new Error('module not found: nats');
    });

    const transport = natsTransport({});
    await expect(transport.start?.()).rejects.toThrow(/optional peer dependency "nats"/);
  });
});

describe('natsTransport - publish guards & headers', () => {
  it('throws when publishing before start()', async () => {
    const transport = natsTransport({
      nats: {
        async connect() {
          throw new Error('n/a');
        },
      },
    });
    await expect(transport.publish({ id: '1', topic: 't', payload: {} })).rejects.toThrow(
      /not started/,
    );
  });

  it('attaches x-event-key and custom headers when present', async () => {
    const published: Array<{ subject: string; data: Uint8Array; hdrs?: NatsHeadersLike }> = [];
    const nc: NatsConnectionLike = {
      publish(subject, data, opts) {
        published.push({ subject, data: data ?? new Uint8Array(), hdrs: opts?.headers });
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
        headers: makeHeaders,
      },
    });
    await transport.start?.();

    const msg: EventMessage = {
      id: 'm1',
      topic: 'events.x',
      key: 'k1',
      headers: { 'x-custom': 'v1' },
      payload: { a: 1 },
    };
    await transport.publish(msg);

    expect(published).toHaveLength(1);
    const hdrs = published[0]?.hdrs;
    expect(hdrs).toBeDefined();
    expect(hdrs?.get('x-event-id')).toBe('m1');
    expect(hdrs?.get('x-event-key')).toBe('k1');
    expect(hdrs?.get('x-custom')).toBe('v1');
    await transport.stop?.();
  });

  it('publishes without headers when the nats module has no headers() factory', async () => {
    const published: Array<{ subject: string; opts?: { headers?: NatsHeadersLike } }> = [];
    const nc: NatsConnectionLike = {
      publish(subject, _data, opts) {
        published.push({ subject, opts });
      },
      subscribe() {
        return { unsubscribe() {} };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();
    await transport.publish({ id: '1', topic: 't', payload: null });
    expect(published[0]?.opts).toBeUndefined();
    await transport.stop?.();
  });
});

describe('natsTransport - jetstream publish', () => {
  it('publishes via jetstream when enabled', async () => {
    const jsPublished: Array<{ subject: string; data: Uint8Array }> = [];
    const js: NatsJetStreamLike = {
      async publish(subject, data) {
        jsPublished.push({ subject, data });
        return undefined;
      },
      async subscribe() {
        return Object.assign((async function* () {})(), {
          unsubscribe() {},
        }) as unknown as AsyncIterable<NatsMsgLike> & { unsubscribe(): void };
      },
    };
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe() {
        return { unsubscribe() {} };
      },
      jetstream() {
        return js;
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      jetstream: true,
      nats: {
        async connect() {
          return nc;
        },
        headers: makeHeaders,
      },
    });
    await transport.start?.();
    await transport.publish({ id: '1', topic: 'orders', payload: { x: 1 } });
    expect(jsPublished).toHaveLength(1);
    expect(jsPublished[0]?.subject).toBe('orders');
    await transport.stop?.();
  });

  it('throws when the server does not expose jetstream on publish', async () => {
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe() {
        return { unsubscribe() {} };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      jetstream: true,
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();
    await expect(transport.publish({ id: '1', topic: 'orders', payload: {} })).rejects.toThrow(
      /does not expose JetStream/,
    );
    await transport.stop?.();
  });
});

describe('natsTransport - core subscribe', () => {
  it('throws when subscribing before start()', async () => {
    const transport = natsTransport({
      nats: {
        async connect() {
          throw new Error('n/a');
        },
      },
    });
    await expect(transport.subscribe('t', async () => {})).rejects.toThrow(/not started/);
  });

  it('decodes headers, acks successfully, and logs a subscription error', async () => {
    let callback: ((err: Error | null, msg: NatsMsgLike) => void) | undefined;
    const sub: NatsSubscriptionLike = { unsubscribe() {} };
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe(_subject, opts) {
        callback = opts?.callback;
        return sub;
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();

    const received: EventMessage[] = [];
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const unsub = await transport.subscribe('events.x', async (msg, ack) => {
      received.push(msg);
      await ack.ack();
    });

    expect(callback).toBeDefined();

    // Error branch: logs and returns without touching handler.
    callback?.(new Error('conn drop'), undefined as unknown as NatsMsgLike);
    expect(errorSpy).toHaveBeenCalled();
    console.error = originalError;

    // Success branch with headers present.
    const hdrs = makeHeaders();
    hdrs.set('x-event-id', 'evt-1');
    hdrs.set('x-event-key', 'key-1');
    let acked = false;
    const msg: NatsMsgLike = {
      subject: 'events.x',
      data: new TextEncoder().encode(JSON.stringify({ hello: 'world' })),
      headers: hdrs,
      ack() {
        acked = true;
      },
    };
    callback?.(null, msg);
    await Bun.sleep(5);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('evt-1');
    expect(received[0]?.key).toBe('key-1');
    expect(received[0]?.payload).toEqual({ hello: 'world' });
    expect(acked).toBe(true);

    await unsub();
    await transport.stop?.();
  });

  it('handles messages without headers and nacks with requeue on handler failure', async () => {
    let callback: ((err: Error | null, msg: NatsMsgLike) => void) | undefined;
    const sub: NatsSubscriptionLike = { unsubscribe() {} };
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe(_subject, opts) {
        callback = opts?.callback;
        return sub;
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();

    let nakMillis: number | undefined;
    let nakCalled = false;
    await transport.subscribe('events.y', async () => {
      throw new Error('handler failed');
    });

    const msg: NatsMsgLike = {
      subject: 'events.y',
      data: new TextEncoder().encode(JSON.stringify({ v: 1 })),
      nak(millis) {
        nakCalled = true;
        nakMillis = millis;
      },
    };
    callback?.(null, msg);
    await Bun.sleep(5);

    expect(nakCalled).toBe(true);
    expect(nakMillis).toBeUndefined();
    await transport.stop?.();
  });

  it('supports explicit ack() and nack({requeue:false}) from the handler', async () => {
    let callback: ((err: Error | null, msg: NatsMsgLike) => void) | undefined;
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe(_subject, opts) {
        callback = opts?.callback;
        return { unsubscribe() {} };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();

    let acked = false;
    let nakMillis: number | undefined = -1;
    await transport.subscribe('events.z', async (_msg, ack) => {
      await ack.nack({ requeue: false });
    });

    const msg: NatsMsgLike = {
      subject: 'events.z',
      data: new TextEncoder().encode('null'),
      ack() {
        acked = true;
      },
      nak(millis) {
        nakMillis = millis;
      },
    };
    callback?.(null, msg);
    await Bun.sleep(5);

    expect(acked).toBe(false);
    expect(nakMillis).toBe(0);
    await transport.stop?.();
  });

  it('drains and closes the connection on stop(), unsubscribing tracked subs', async () => {
    let unsubscribed = false;
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe() {
        return {
          unsubscribe() {
            unsubscribed = true;
          },
        };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();
    await transport.subscribe('t', async () => {});
    await transport.stop?.();
    expect(unsubscribed).toBe(true);
  });
});

describe('natsTransport - jetstream subscribe', () => {
  it('iterates jetstream messages and supports unsubscribe', async () => {
    let unsubscribed = false;
    const msgs: NatsMsgLike[] = [
      {
        subject: 'orders',
        data: new TextEncoder().encode(JSON.stringify({ n: 1 })),
        ack() {},
      },
    ];
    const iterable = {
      unsubscribe() {
        unsubscribed = true;
      },
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < msgs.length) {
              return { value: msgs[i++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    } as unknown as AsyncIterable<NatsMsgLike> & { unsubscribe(): void };

    const js: NatsJetStreamLike = {
      async publish() {
        return undefined;
      },
      async subscribe() {
        return iterable;
      },
    };
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe() {
        return { unsubscribe() {} };
      },
      jetstream() {
        return js;
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };

    const received: unknown[] = [];
    const transport = natsTransport({
      jetstream: true,
      durable: 'dur1',
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();

    const unsub = await transport.subscribe('orders', async (msg, ack) => {
      received.push(msg.payload);
      await ack.ack();
    });
    await Bun.sleep(10);

    expect(received).toEqual([{ n: 1 }]);

    await unsub();
    expect(unsubscribed).toBe(true);
    await transport.stop?.();
  });

  it('throws when the server does not expose jetstream on subscribe', async () => {
    const nc: NatsConnectionLike = {
      publish() {},
      subscribe() {
        return { unsubscribe() {} };
      },
      async drain() {},
      async close() {},
      isClosed() {
        return false;
      },
    };
    const transport = natsTransport({
      jetstream: true,
      nats: {
        async connect() {
          return nc;
        },
      },
    });
    await transport.start?.();
    await expect(transport.subscribe('t', async () => {})).rejects.toThrow(
      /does not expose JetStream/,
    );
    await transport.stop?.();
  });
});

// Keep NatsLike import used for typing consistency across the suite.
void (undefined as unknown as NatsLike);
