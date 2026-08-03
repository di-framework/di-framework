import type { Ack, EventMessage, EventTransport, Unsubscribe } from '../types.ts';

type Handler = (msg: EventMessage, ack: Ack) => Promise<void>;

export interface MemoryTransportOptions {
  /** Simulate async delivery delay in ms. Defaults to 0. */
  delayMs?: number;
}

/**
 * In-process transport for tests and local development.
 * Messages are delivered to all active subscribers of a topic.
 */
export function memoryTransport(options: MemoryTransportOptions = {}): EventTransport {
  const delayMs = options.delayMs ?? 0;
  const subscribers = new Map<string, Set<Handler>>();
  let started = false;
  const queue: EventMessage[] = [];

  const deliver = async (message: EventMessage): Promise<void> => {
    const handlers = subscribers.get(message.topic);
    if (!handlers || handlers.size === 0) return;

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    await Promise.all(
      [...handlers].map(async (handler) => {
        let settled = false;
        const ack: Ack = {
          ack() {
            settled = true;
          },
          nack() {
            settled = true;
          },
        };
        try {
          await handler(message, ack);
          if (!settled) ack.ack();
        } catch {
          if (!settled) ack.nack({ requeue: false });
        }
      }),
    );
  };

  return {
    async start() {
      started = true;
      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg) await deliver(msg);
      }
    },

    async stop() {
      started = false;
      subscribers.clear();
      queue.length = 0;
    },

    async publish(message: EventMessage) {
      if (!started) {
        queue.push(message);
        return;
      }
      await deliver(message);
    },

    async subscribe(topic: string, handler: Handler): Promise<Unsubscribe> {
      if (!subscribers.has(topic)) subscribers.set(topic, new Set());
      subscribers.get(topic)?.add(handler);
      return () => {
        subscribers.get(topic)?.delete(handler);
      };
    },
  };
}
