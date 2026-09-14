import { WorkloadService } from '@di-framework/wasmcloud';
import { pallets, Sync } from './bindings';

export type StockEvent = { sku: string; qty: number };
export type StockMessage = {
  subject: string;
  body: AsyncIterable<Uint8Array | number>;
  replyTo?: string;
};

export async function applyRemote(event: StockEvent): Promise<void> {
  const store = await pallets();
  await store.set(event.sku, String(event.qty));
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

/** The host owns the subscription and invokes this service for each delivery. */
export const handleMessage = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(
  async function handleMessage(message: StockMessage): Promise<void> {
    if (message.subject !== 'warehouse.stock') throw { tag: 'reject' };
    const buffer: number[] = [];
    for await (const chunk of message.body) {
      if (typeof chunk === 'number') buffer.push(chunk);
      else for (const byte of chunk) buffer.push(byte);
      if (buffer.length > 4096) throw { tag: 'reject' };
    }
    let event: StockEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
      if (
        !event ||
        typeof event.sku !== 'string' ||
        !event.sku.trim() ||
        !Number.isSafeInteger(event.qty) ||
        event.qty < 0
      )
        throw new Error('Invalid stock event');
    } catch {
      throw { tag: 'reject' };
    }
    await applyRemote(event);
    if (message.replyTo) {
      const result = await new Sync().publish({
        subject: message.replyTo,
        body: bytes(JSON.stringify({ ok: true, ...event })),
        replyTo: undefined,
      });
      if (result && typeof result === 'object' && 'tag' in result && result.tag === 'err') {
        throw { tag: 'retry' };
      }
    }
  },
);
