import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';
import { createEventBridge, memoryTransport } from '@di-framework/events';

beforeEach(() => {
  useContainer().clear();
});

describe('events example', () => {
  it('bridges publisher output to a topic and inbound payments to subscribers', async () => {
    const placed: unknown[] = [];
    const paid: unknown[] = [];
    const topicOrders: unknown[] = [];

    @Container()
    class Orders {
      @Publisher('order.placed')
      place(id: string) {
        return { id };
      }
    }

    @Container()
    class Listeners {
      @Subscriber('order.placed')
      onPlaced(p: unknown) {
        const envelope = p as { result?: unknown };
        placed.push(envelope.result ?? p);
      }
      @Subscriber('payment.captured')
      onPaid(p: unknown) {
        paid.push(p);
      }
    }

    const transport = memoryTransport();
    await transport.start?.();
    await transport.subscribe('orders', async (msg, ack) => {
      topicOrders.push(msg.payload);
      ack.ack();
    });

    const bridge = createEventBridge({
      transport,
      routes: {
        outbound: [{ event: 'order.placed', topic: 'orders' }],
        inbound: [{ topic: 'payments.captured', event: 'payment.captured' }],
      },
    });
    await bridge.start();

    const c = useContainer();
    c.resolve(Listeners);
    c.resolve(Orders).place('o1');
    await Bun.sleep(20);

    expect(placed).toEqual([{ id: 'o1' }]);
    expect(topicOrders).toEqual([{ id: 'o1' }]);

    await transport.publish({
      id: 'p1',
      topic: 'payments.captured',
      payload: { orderId: 'o1' },
    });
    await Bun.sleep(20);

    expect(paid).toEqual([{ orderId: 'o1' }]);
    await bridge.stop();
  });
});
