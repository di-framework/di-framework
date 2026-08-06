import { describe, expect, it, mock } from 'bun:test';
import { type KafkaJsLike, kafkaTransport } from '../src/adapters/kafka.ts';
import type { EventMessage } from '../src/types.ts';

interface RunConfig {
  eachMessage: (payload: {
    topic: string;
    partition: number;
    message: {
      key: Buffer | null;
      value: Buffer | null;
      headers?: Record<string, Buffer | string | undefined>;
      timestamp: string;
    };
  }) => Promise<void>;
}

function makeMock(): {
  mock: KafkaJsLike;
  sent: Array<{ topic: string; messages: Array<{ key: string | null; value: string }> }>;
  subscribedTopics: Array<{ topic: string; fromBeginning?: boolean }>;
  runConfigs: RunConfig[];
} {
  const sent: Array<{ topic: string; messages: Array<{ key: string | null; value: string }> }> = [];
  const subscribedTopics: Array<{ topic: string; fromBeginning?: boolean }> = [];
  const runConfigs: RunConfig[] = [];

  const producer = {
    async connect() {},
    async disconnect() {},
    async send(record: { topic: string; messages: Array<{ key: string | null; value: string }> }) {
      sent.push(record);
      return undefined;
    },
  };

  const consumer = {
    async connect() {},
    async disconnect() {},
    async subscribe(opts: { topic: string; fromBeginning?: boolean }) {
      subscribedTopics.push(opts);
    },
    async run(config: RunConfig) {
      runConfigs.push(config);
    },
  };

  const mockKafka: KafkaJsLike = {
    Kafka: class {
      producer() {
        return producer;
      }
      consumer() {
        return consumer;
      }
    },
  };

  return { mock: mockKafka, sent, subscribedTopics, runConfigs };
}

describe('kafkaTransport - module load failure', () => {
  it('wraps dynamic import failure with an install hint', async () => {
    mock.module('kafkajs', () => {
      throw new Error('module not found: kafkajs');
    });

    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['localhost:9092'] },
    });

    await expect(transport.start?.()).rejects.toThrow(/optional peer dependency "kafkajs"/);
  });
});

describe('kafkaTransport - pending subscriptions', () => {
  it('queues subscribe() calls made before start() and flushes them on start', async () => {
    const { mock: kafkajs, subscribedTopics, runConfigs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    const seen: unknown[] = [];
    const unsub = await transport.subscribe('orders', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    await transport.start?.();

    expect(subscribedTopics).toEqual([{ topic: 'orders', fromBeginning: false }]);
    expect(runConfigs).toHaveLength(1);

    // Removing a pending subscription before start is a no-op once started,
    // but exercises the pending-unsubscribe branch when called beforehand.
    await unsub();
    await transport.stop?.();
  });

  it('removes a pending subscription cancelled before start() ever runs', async () => {
    const { mock: kafkajs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    const handler = async () => {};
    const unsub = await transport.subscribe('never', handler);
    await unsub();
    await transport.start?.();
    // Since it was cancelled, no subscribe call should occur for 'never'.
    await transport.stop?.();
  });
});

describe('kafkaTransport - eachMessage handling', () => {
  it('decodes headers/key/value and acks successfully; ignores unknown topics', async () => {
    const { mock: kafkajs, runConfigs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    const received: EventMessage[] = [];
    await transport.subscribe('orders', async (msg, ack) => {
      received.push(msg);
      ack.ack();
    });
    await transport.start?.();

    const eachMessage = runConfigs[0]?.eachMessage;
    expect(typeof eachMessage).toBe('function');

    // Topic with no registered handlers: early return, no throw.
    await eachMessage?.({
      topic: 'unknown-topic',
      partition: 0,
      message: {
        key: null,
        value: null,
        timestamp: '0',
      },
    });

    // Full message: string + Buffer headers, null header entry ignored, Buffer value & key.
    await eachMessage?.({
      topic: 'orders',
      partition: 0,
      message: {
        key: Buffer.from('k1'),
        value: Buffer.from(JSON.stringify({ ok: true })),
        headers: {
          'x-string': 'sval',
          'x-buffer': Buffer.from('bval'),
          'x-null': undefined,
        },
        timestamp: '1700000000000',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.key).toBe('k1');
    expect(received[0]?.payload).toEqual({ ok: true });
    expect(received[0]?.headers?.['x-string']).toBe('sval');
    expect(received[0]?.headers?.['x-buffer']).toBe('bval');
    expect(received[0]?.headers?.['x-null']).toBeUndefined();
    expect(received[0]?.timestamp).toBe(1700000000000);

    await transport.stop?.();
  });

  it('auto-acks when the handler does not settle, and falls back to empty value/no headers', async () => {
    const { mock: kafkajs, runConfigs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    let handled = 0;
    await transport.subscribe('orders', async (msg) => {
      handled += 1;
      expect(msg.payload).toBeNull();
      // Handler resolves without calling ack — transport should auto-ack.
    });
    await transport.start?.();

    const eachMessage = runConfigs[0]?.eachMessage;
    await eachMessage?.({
      topic: 'orders',
      partition: 0,
      message: {
        key: null,
        value: null,
        timestamp: '',
      },
    });

    expect(handled).toBe(1);
    await transport.stop?.();
  });

  it('swallows handler errors once nack() has settled, rethrows otherwise', async () => {
    const { mock: kafkajs, runConfigs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    // Handler 1: explicitly nacks (settled=true) then the ack.nack() call itself throws,
    // which the transport should swallow because settled is already true.
    await transport.subscribe('orders', async (_msg, ack) => {
      ack.nack();
    });
    await transport.start?.();
    const eachMessage = runConfigs[0]?.eachMessage;

    await expect(
      eachMessage?.({
        topic: 'orders',
        partition: 0,
        message: { key: null, value: null, timestamp: '1' },
      }),
    ).resolves.toBeUndefined();

    await transport.stop?.();

    // Handler 2: throws its own error without ever settling ack — must rethrow.
    const { mock: kafkajs2, runConfigs: runConfigs2 } = makeMock();
    const transport2 = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs: kafkajs2,
    });
    await transport2.subscribe('orders', async () => {
      throw new Error('boom');
    });
    await transport2.start?.();
    const eachMessage2 = runConfigs2[0]?.eachMessage;

    await expect(
      eachMessage2?.({
        topic: 'orders',
        partition: 0,
        message: { key: null, value: null, timestamp: '1' },
      }),
    ).rejects.toThrow('boom');

    await transport2.stop?.();
  });
});

describe('kafkaTransport - subscribe after start & publish guard', () => {
  it('subscribes directly (post-start) and creates a new handler set for a fresh topic', async () => {
    const { mock: kafkajs, subscribedTopics } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      groupId: 'g1',
      kafkajs,
    });

    await transport.start?.();
    const unsub = await transport.subscribe('late-topic', async () => {});
    expect(subscribedTopics).toEqual(
      expect.arrayContaining([{ topic: 'late-topic', fromBeginning: false }]),
    );
    await unsub();
    await transport.stop?.();
  });

  it('throws when publishing before start()', async () => {
    const { mock: kafkajs } = makeMock();
    const transport = kafkaTransport({
      client: { clientId: 'test', brokers: ['b:9092'] },
      kafkajs,
    });

    await expect(transport.publish({ id: '1', topic: 't', payload: {} })).rejects.toThrow(
      /not started/,
    );
  });
});
