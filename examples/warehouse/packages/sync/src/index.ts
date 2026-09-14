import { WorkloadService } from '@di-framework/wasmcloud';
import { pallets, Sync } from './bindings';

export type StockEvent = {
  sku: string;
  qty: number;
};

const listeners = new Set<(event: StockEvent) => void>();

/** Test stand-in for a long-lived messaging subscribe. */
export async function* subscribe(_bus: Sync, _subject: string): AsyncIterable<StockEvent> {
  const queue: StockEvent[] = [];
  let notify: (() => void) | undefined;
  const listener = (event: StockEvent) => {
    queue.push(event);
    notify?.();
  };
  listeners.add(listener);
  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const next = queue.shift();
      if (next) yield next;
    }
  } finally {
    listeners.delete(listener);
  }
}

export function publishPeer(event: StockEvent): void {
  for (const listener of listeners) listener(event);
}

export async function applyRemote(event: StockEvent): Promise<void> {
  const store = await pallets();
  await store.set(event.sku, String(event.qty));
}

export const run = WorkloadService({ workload: 'warehouse' })(async function run(): Promise<void> {
  const bus = new Sync();
  for await (const event of subscribe(bus, 'warehouse.stock')) {
    await applyRemote(event);
  }
});
