/**
 * @di-framework/events example
 *
 * Domain services use core @Publisher / @Subscriber.
 * An EventBridge + memoryTransport maps those events onto topics.
 */

import { useContainer } from '@di-framework/core/container';
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';
import { EventBridge, Inbound, memoryTransport, Outbound } from '@di-framework/events';

const transport = memoryTransport();

@EventBridge({ transport: () => transport })
class OrderEvents {
  @Outbound('order.placed', {
    topic: 'orders',
    key: (p: unknown) => {
      if (p && typeof p === 'object' && 'result' in p) {
        const result = (p as { result?: { id?: string } }).result;
        return result?.id;
      }
      return undefined;
    },
  })
  outboundOrders!: undefined;

  @Inbound({ topic: 'payments.captured', event: 'payment.captured' })
  inboundPayments!: undefined;
}

@Container()
class OrderService {
  @Publisher('order.placed')
  place(id: string, total: number) {
    return { id, total };
  }
}

@Container()
class FulfillmentService {
  @Subscriber('order.placed')
  onPlaced(payload: unknown) {
    const envelope = payload as { result?: { id: string; total: number } };
    const order = envelope.result ?? (payload as { id: string; total: number });
    console.log(`[fulfillment] order ${order.id} total=${order.total}`);
  }

  @Subscriber('payment.captured')
  onPaid(payload: unknown) {
    console.log(`[fulfillment] payment captured`, payload);
  }
}

const container = useContainer();
container.resolve(OrderEvents);
container.resolve(FulfillmentService);
const orders = container.resolve(OrderService);

// Wait for autoStart microtask
await Bun.sleep(20);

console.log('--- place order (local subscriber + outbound topic) ---');
orders.place('o-100', 42);

await Bun.sleep(20);

console.log('--- simulate remote payment on topic payments.captured ---');
await transport.publish({
  id: crypto.randomUUID(),
  topic: 'payments.captured',
  payload: { orderId: 'o-100', amount: 42 },
});

await Bun.sleep(20);

console.log('done');
container.clear();
