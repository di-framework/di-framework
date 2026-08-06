import { describe, expect, it } from 'bun:test';
import { type KafkaJsLike, kafkaTransport } from '../src/adapters/kafka.ts';
import { memoryTransport } from '../src/adapters/memory.ts';
import { type NatsConnectionLike, natsTransport } from '../src/adapters/nats.ts';
import type { EventMessage } from '../src/types.ts';

describe('memoryTransport', () => {
  it('delivers published messages to subscribers', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });
    await transport.publish({ id: '1', topic: 't', payload: { x: 1 } });
    expect(seen).toEqual([{ x: 1 }]);
    await transport.stop?.();
  });

  it('queues publishes made before start() and flushes them in order on start()', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.subscribe('t', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    await transport.publish({ id: '1', topic: 't', payload: 'a' });
    await transport.publish({ id: '2', topic: 't', payload: 'b' });
    expect(seen).toEqual([]);

    await transport.start?.();
    expect(seen).toEqual(['a', 'b']);
    await transport.stop?.();
  });

  it('nacks (without rethrowing) when a handler throws', async () => {
    const transport = memoryTransport();
    let handled = 0;
    await transport.start?.();
    await transport.subscribe('t', async () => {
      handled += 1;
      throw new Error('boom');
    });

    await expect(transport.publish({ id: '1', topic: 't', payload: {} })).resolves.toBeUndefined();
    expect(handled).toBe(1);
    await transport.stop?.();
  });

  it('delivers with a simulated delay when delayMs is set', async () => {
    const transport = memoryTransport({ delayMs: 5 });
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });
    const start = Date.now();
    await transport.publish({ id: '1', topic: 't', payload: 'x' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
    expect(seen).toEqual(['x']);
    await transport.stop?.();
  });

  it('clears subscribers and the queue on stop()', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });
    await transport.stop?.();

    // After stop(), publishing queues again (started=false) rather than delivering.
    await transport.publish({ id: '1', topic: 't', payload: 'queued' });
    expect(seen).toEqual([]);
  });

  it('allows unsubscribing a handler', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    const unsub = await transport.subscribe('t', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });
    await unsub();
    await transport.publish({ id: '1', topic: 't', payload: 'gone' });
    expect(seen).toEqual([]);
  });
});

describe('kafkaTransport', () => {
  it('publishes through an injected KafkaJS mock', async () => {
    const sent: Array<{
      topic: string;
      messages: Array<{ key: string | null; value: string }>;
    }> = [];
    const producer = {
      async connect() {},
      async disconnect() {},
      async send(record: {
        topic: string;
        messages: Array<{ key: string | null; value: string }>;
      }) {
        sent.push(record);
      },
    };
    const mock: KafkaJsLike = {
      Kafka: class {
        producer() {
          return producer;
        }
        consumer() {
          return {
            async connect() {},
            async disconnect() {},
            async subscribe() {},
            async run() {},
          };
        }
      },
    };

    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['localhost:9092'] },
      groupId: 'g1',
      kafkajs: mock,
    });

    await transport.start?.();
    await transport.publish({
      id: 'm1',
      topic: 'orders',
      key: 'k1',
      payload: { ok: true },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.topic).toBe('orders');
    expect(sent[0]?.messages[0]?.key).toBe('k1');
    expect(JSON.parse(sent[0]?.messages[0]?.value ?? 'null')).toEqual({ ok: true });
    await transport.stop?.();
  });

  it('requires groupId to subscribe', async () => {
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['localhost:9092'] },
      kafkajs: {
        Kafka: class {
          producer() {
            return {
              async connect() {},
              async disconnect() {},
              async send() {},
            };
          }
          consumer() {
            return {
              async connect() {},
              async disconnect() {},
              async subscribe() {},
              async run() {},
            };
          }
        },
      },
    });
    await expect(transport.subscribe('t', async () => {})).rejects.toThrow(/groupId/);
  });
});

describe('natsTransport', () => {
  it('publishes through an injected nats mock', async () => {
    const published: Array<{ subject: string; data: Uint8Array }> = [];
    const headersFactory = () => {
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
    };

    const nc: NatsConnectionLike = {
      publish(subject: string, data?: Uint8Array) {
        published.push({ subject, data: data ?? new Uint8Array() });
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
        headers: headersFactory,
      },
    });

    await transport.start?.();
    const msg: EventMessage = { id: '1', topic: 'events.x', payload: { a: 1 } };
    await transport.publish(msg);

    expect(published).toHaveLength(1);
    expect(published[0]?.subject).toBe('events.x');
    expect(JSON.parse(new TextDecoder().decode(published[0]?.data))).toEqual({ a: 1 });
    await transport.stop?.();
  });
});
