import { JsonCodec, stringFromCodecOutput } from '../codec.ts';
import type { Ack, EventCodec, EventMessage, EventTransport, Unsubscribe } from '../types.ts';

export interface KafkaTransportOptions {
  /** KafkaJS client config (brokers, clientId, ssl, sasl, …). */
  client: {
    clientId: string;
    brokers: string[];
    [key: string]: unknown;
  };
  /** Consumer group id. Required for subscribe(). */
  groupId?: string;
  /** Topic → fromBeginning override. Defaults to false. */
  fromBeginning?: boolean;
  codec?: EventCodec;
  /** Injected KafkaJS module for tests. Defaults to dynamic `import('kafkajs')`. */
  kafkajs?: KafkaJsLike;
}

interface KafkaProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{
      key?: string | null;
      value: string | Buffer | null;
      headers?: Record<string, string>;
    }>;
  }): Promise<unknown>;
}

interface KafkaConsumer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(config: {
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
  }): Promise<void>;
}

interface KafkaClient {
  producer(config?: unknown): KafkaProducer;
  consumer(config: { groupId: string }): KafkaConsumer;
}

/** Minimal KafkaJS surface we depend on (keeps types soft without a hard dep). */
export interface KafkaJsLike {
  Kafka: new (config: Record<string, unknown>) => KafkaClient;
}

/**
 * Kafka transport backed by optional peer dependency `kafkajs`.
 * Topic creation is left to operators.
 */
export function kafkaTransport(options: KafkaTransportOptions): EventTransport {
  const codec = options.codec ?? JsonCodec;
  let kafkaModule: KafkaJsLike | undefined = options.kafkajs;
  let producer: KafkaProducer | undefined;
  let consumer: KafkaConsumer | undefined;
  let started = false;
  const pendingSubscribes: Array<{
    topic: string;
    handler: (msg: EventMessage, ack: Ack) => Promise<void>;
  }> = [];
  const handlers = new Map<string, Set<(msg: EventMessage, ack: Ack) => Promise<void>>>();

  async function loadKafka(): Promise<KafkaJsLike> {
    if (kafkaModule) return kafkaModule;
    try {
      kafkaModule = (await import('kafkajs')) as unknown as KafkaJsLike;
      return kafkaModule;
    } catch (err) {
      throw new Error(
        '@di-framework/events/kafka requires the optional peer dependency "kafkajs". Install it with: bun add kafkajs',
        { cause: err },
      );
    }
  }

  return {
    async start() {
      if (started) return;
      const mod = await loadKafka();
      const kafka = new mod.Kafka(options.client);
      producer = kafka.producer();
      await producer.connect();

      if (options.groupId) {
        consumer = kafka.consumer({ groupId: options.groupId });
        await consumer.connect();

        for (const pending of pendingSubscribes) {
          let set = handlers.get(pending.topic);
          if (!set) {
            set = new Set();
            handlers.set(pending.topic, set);
          }
          set.add(pending.handler);
          await consumer.subscribe({
            topic: pending.topic,
            fromBeginning: options.fromBeginning ?? false,
          });
        }
        pendingSubscribes.length = 0;

        await consumer.run({
          eachMessage: async ({ topic, message }) => {
            const set = handlers.get(topic);
            if (!set || set.size === 0) return;

            const headers: Record<string, string> = {};
            if (message.headers) {
              for (const [k, v] of Object.entries(message.headers)) {
                if (v == null) continue;
                headers[k] = typeof v === 'string' ? v : Buffer.from(v as Buffer).toString('utf8');
              }
            }

            const raw = message.value
              ? typeof message.value === 'string'
                ? message.value
                : new Uint8Array(message.value)
              : '';
            const payload = codec.decode(raw || 'null');

            const eventMessage: EventMessage = {
              id: headers['x-event-id'] ?? crypto.randomUUID(),
              topic,
              key: message.key ? message.key.toString('utf8') : undefined,
              headers,
              payload,
              timestamp: message.timestamp ? Number(message.timestamp) : Date.now(),
            };

            for (const handler of set) {
              let settled = false;
              const ack: Ack = {
                ack() {
                  settled = true;
                },
                nack() {
                  settled = true;
                  throw new Error('nack');
                },
              };
              try {
                await handler(eventMessage, ack);
                if (!settled) ack.ack();
              } catch (err) {
                if (!settled) throw err;
              }
            }
          },
        });
      }

      started = true;
    },

    async stop() {
      await consumer?.disconnect?.();
      await producer?.disconnect?.();
      consumer = undefined;
      producer = undefined;
      handlers.clear();
      started = false;
    },

    async publish(message: EventMessage) {
      if (!started || !producer) {
        throw new Error('Kafka transport is not started. Call start() before publish().');
      }
      const value = stringFromCodecOutput(codec.encode(message.payload));
      const headers: Record<string, string> = {
        ...(message.headers ?? {}),
        'x-event-id': message.id,
      };
      await producer.send({
        topic: message.topic,
        messages: [
          {
            key: message.key ?? null,
            value,
            headers,
          },
        ],
      });
    },

    async subscribe(
      topic: string,
      handler: (msg: EventMessage, ack: Ack) => Promise<void>,
    ): Promise<Unsubscribe> {
      if (!options.groupId) {
        throw new Error('kafkaTransport requires groupId to subscribe');
      }

      if (!started) {
        pendingSubscribes.push({ topic, handler });
        return async () => {
          const idx = pendingSubscribes.findIndex(
            (p) => p.topic === topic && p.handler === handler,
          );
          if (idx >= 0) pendingSubscribes.splice(idx, 1);
          handlers.get(topic)?.delete(handler);
        };
      }

      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
      await consumer?.subscribe({
        topic,
        fromBeginning: options.fromBeginning ?? false,
      });

      return async () => {
        handlers.get(topic)?.delete(handler);
      };
    },
  };
}
