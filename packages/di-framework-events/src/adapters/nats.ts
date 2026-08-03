import { JsonCodec, stringFromCodecOutput } from '../codec.ts';
import type { Ack, EventCodec, EventMessage, EventTransport, Unsubscribe } from '../types.ts';

export interface NatsTransportOptions {
  /** NATS server URL(s). Defaults to `nats://127.0.0.1:4222`. */
  servers?: string | string[];
  /** Use JetStream for durable publish/subscribe when true. */
  jetstream?: boolean;
  /** JetStream durable consumer name (required when jetstream + subscribe). */
  durable?: string;
  /** Extra connect options forwarded to `nats.connect`. */
  connect?: Record<string, unknown>;
  codec?: EventCodec;
  /** Injected nats module for tests. */
  nats?: NatsLike;
}

export interface NatsLike {
  connect(opts?: Record<string, unknown>): Promise<NatsConnectionLike>;
  StringCodec?: () => { encode(s: string): Uint8Array; decode(b: Uint8Array): string };
  headers?: () => NatsHeadersLike;
}

export interface NatsHeadersLike {
  set(key: string, value: string): void;
  keys(): Iterable<string>;
  get(key: string): string;
}

export interface NatsConnectionLike {
  publish(subject: string, data?: Uint8Array, opts?: { headers?: NatsHeadersLike }): void;
  subscribe(
    subject: string,
    opts?: { callback?: (err: Error | null, msg: NatsMsgLike) => void },
  ): NatsSubscriptionLike;
  jetstream?: () => NatsJetStreamLike;
  jetstreamManager?: () => Promise<unknown>;
  drain(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface NatsMsgLike {
  subject: string;
  data: Uint8Array;
  headers?: NatsHeadersLike;
  respond?: (data?: Uint8Array) => boolean;
  ack?: () => void;
  nak?: (millis?: number) => void;
}

export interface NatsSubscriptionLike {
  unsubscribe(): void;
  getSubject?(): string;
  [Symbol.asyncIterator]?: () => AsyncIterator<NatsMsgLike>;
}

export interface NatsJetStreamLike {
  publish(
    subject: string,
    data: Uint8Array,
    opts?: { headers?: NatsHeadersLike },
  ): Promise<unknown>;
  subscribe(
    subject: string,
    opts?: { config?: { durable_name?: string } },
  ): Promise<AsyncIterable<NatsMsgLike> & { unsubscribe(): void }>;
}

/**
 * NATS transport backed by optional peer dependency `nats`.
 * Set `jetstream: true` for durable streams; otherwise uses core NATS pub/sub.
 */
export function natsTransport(options: NatsTransportOptions = {}): EventTransport {
  const codec = options.codec ?? JsonCodec;
  let natsModule: NatsLike | undefined = options.nats;
  let nc: NatsConnectionLike | undefined;
  let started = false;
  const unsubs: Array<() => void> = [];

  async function loadNats(): Promise<NatsLike> {
    if (natsModule) return natsModule;
    try {
      natsModule = (await import('nats')) as unknown as NatsLike;
      return natsModule;
    } catch (err) {
      throw new Error(
        '@di-framework/events/nats requires the optional peer dependency "nats". Install it with: bun add nats',
        { cause: err },
      );
    }
  }

  function encodePayload(payload: unknown): Uint8Array {
    return new TextEncoder().encode(stringFromCodecOutput(codec.encode(payload)));
  }

  function decodePayload(data: Uint8Array): unknown {
    return codec.decode(data);
  }

  function headersToRecord(h?: NatsHeadersLike): Record<string, string> | undefined {
    if (!h) return undefined;
    const out: Record<string, string> = {};
    for (const key of h.keys()) {
      out[key] = h.get(key);
    }
    return out;
  }

  return {
    async start() {
      if (started) return;
      const mod = await loadNats();
      nc = await mod.connect({
        servers: options.servers ?? 'nats://127.0.0.1:4222',
        ...(options.connect ?? {}),
      });
      started = true;
    },

    async stop() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      if (nc && !nc.isClosed()) {
        await nc.drain();
        await nc.close();
      }
      nc = undefined;
      started = false;
    },

    async publish(message: EventMessage) {
      if (!started || !nc) {
        throw new Error('NATS transport is not started. Call start() before publish().');
      }
      const data = encodePayload(message.payload);
      const mod = await loadNats();
      let hdrs: NatsHeadersLike | undefined;
      if (mod.headers) {
        hdrs = mod.headers();
        hdrs.set('x-event-id', message.id);
        if (message.key) hdrs.set('x-event-key', message.key);
        if (message.headers) {
          for (const [k, v] of Object.entries(message.headers)) hdrs.set(k, v);
        }
      }

      if (options.jetstream) {
        const js = nc.jetstream?.();
        if (!js) throw new Error('Connected NATS server does not expose JetStream');
        await js.publish(message.topic, data, hdrs ? { headers: hdrs } : undefined);
      } else {
        nc.publish(message.topic, data, hdrs ? { headers: hdrs } : undefined);
      }
    },

    async subscribe(
      topic: string,
      handler: (msg: EventMessage, ack: Ack) => Promise<void>,
    ): Promise<Unsubscribe> {
      if (!started || !nc) {
        throw new Error('NATS transport is not started. Call start() before subscribe().');
      }

      const handleMsg = async (m: NatsMsgLike) => {
        const headers = headersToRecord(m.headers);
        const eventMessage: EventMessage = {
          id: headers?.['x-event-id'] ?? crypto.randomUUID(),
          topic: m.subject,
          key: headers?.['x-event-key'],
          headers,
          payload: decodePayload(m.data),
          timestamp: Date.now(),
        };

        let settled = false;
        const ack: Ack = {
          ack() {
            settled = true;
            m.ack?.();
          },
          nack(opts) {
            settled = true;
            if (m.nak) m.nak(opts?.requeue === false ? 0 : undefined);
          },
        };

        try {
          await handler(eventMessage, ack);
          if (!settled) ack.ack();
        } catch {
          if (!settled) ack.nack({ requeue: true });
        }
      };

      if (options.jetstream) {
        const js = nc.jetstream?.();
        if (!js) throw new Error('Connected NATS server does not expose JetStream');
        const sub = await js.subscribe(topic, {
          config: options.durable ? { durable_name: options.durable } : undefined,
        });
        const iter = (async () => {
          for await (const m of sub) {
            await handleMsg(m);
          }
        })();
        void iter;
        const unsub = () => sub.unsubscribe();
        unsubs.push(unsub);
        return async () => unsub();
      }

      const sub = nc.subscribe(topic, {
        callback: (err, msg) => {
          if (err) {
            console.error('[natsTransport] subscription error', err);
            return;
          }
          void handleMsg(msg);
        },
      });
      const unsub = () => sub.unsubscribe();
      unsubs.push(unsub);
      return async () => unsub();
    },
  };
}
