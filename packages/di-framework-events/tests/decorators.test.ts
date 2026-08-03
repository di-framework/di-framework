import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { memoryTransport } from '../src/adapters/memory.ts';
import { EventBridge, Inbound, Outbound, startEventBridges } from '../src/decorators.ts';
import registry from '../src/registry.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

describe('@EventBridge / @Outbound / @Inbound', () => {
  it('registers routes on the registry', () => {
    @EventBridge({ transport: () => memoryTransport(), autoStart: false })
    class OrderEvents {
      @Outbound('order.placed', { topic: 'orders' })
      outboundOrders!: undefined;

      @Inbound({ topic: 'payments', event: 'payment.captured' })
      inboundPayments!: undefined;
    }

    void OrderEvents;
    const entries = registry.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.outbound.length > 0 || e.inbound.length > 0);
    expect(entry).toBeDefined();
    expect(entry?.outbound).toEqual([
      expect.objectContaining({ event: 'order.placed', topic: 'orders' }),
    ]);
    expect(entry?.inbound).toEqual([
      expect.objectContaining({ topic: 'payments', event: 'payment.captured' }),
    ]);
  });

  it('starts via startEventBridges and bridges outbound', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];

    @EventBridge({ transport: () => transport, autoStart: false })
    class Wire {
      @Outbound('tick', { topic: 'ticks' })
      out!: undefined;
    }

    void Wire;

    await transport.start?.();
    await transport.subscribe('ticks', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    await startEventBridges();
    useContainer().emit('tick', { className: 'A', methodName: 'b', result: 7 });
    await Bun.sleep(20);

    expect(seen).toEqual([7]);
  });

  it('auto-starts on resolve when autoStart is true', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];

    @EventBridge({ transport: () => transport })
    class AutoWire {
      @Outbound('ping', { topic: 'pings' })
      out!: undefined;
    }

    await transport.start?.();
    await transport.subscribe('pings', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    useContainer().resolve(AutoWire);
    await Bun.sleep(30);

    useContainer().emit('ping', { className: 'A', methodName: 'b', result: 'pong' });
    await Bun.sleep(20);

    expect(seen).toEqual(['pong']);
  });
});
