import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { memoryTransport } from '../src/adapters/memory.ts';
import { EventBridge, Inbound, Outbound, startEventBridges } from '../src/decorators.ts';
import registry from '../src/registry.ts';
import type { EventTransport } from '../src/types.ts';

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

interface BridgedInstance {
  $startBridge?: () => Promise<{ started: boolean; start(): Promise<void>; stop(): Promise<void> }>;
  $stopBridge?: () => Promise<void>;
}

describe('resolveTransport branches', () => {
  it('uses a plain transport object passed via options.transport', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t-plain', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    @EventBridge({ transport, autoStart: false })
    class PlainTransportBridge {
      @Outbound('plain.event', { topic: 't-plain' })
      out!: undefined;
    }

    const instance = useContainer().resolve(PlainTransportBridge) as BridgedInstance;
    await instance.$startBridge?.();
    useContainer().emit('plain.event', { x: 1 });
    await Bun.sleep(10);
    expect(seen).toEqual([{ x: 1 }]);
    await instance.$stopBridge?.();
  });

  it('falls back to instance.transport when options.transport is omitted', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t-instance', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    @EventBridge({ autoStart: false })
    class InstanceTransportBridge {
      transport = transport;
      @Outbound('instance.event', { topic: 't-instance' })
      out!: undefined;
    }

    const instance = useContainer().resolve(InstanceTransportBridge) as BridgedInstance;
    await instance.$startBridge?.();
    useContainer().emit('instance.event', { y: 2 });
    await Bun.sleep(10);
    expect(seen).toEqual([{ y: 2 }]);
    await instance.$stopBridge?.();
  });

  it('resolves the transport from the container using transportToken', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('t-token', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    useContainer().registerFactory('EventTransport', () => transport);

    @EventBridge({ autoStart: false })
    class TokenTransportBridge {
      @Outbound('token.event', { topic: 't-token' })
      out!: undefined;
    }

    const instance = useContainer().resolve(TokenTransportBridge) as BridgedInstance;
    await instance.$startBridge?.();
    useContainer().emit('token.event', { z: 3 });
    await Bun.sleep(10);
    expect(seen).toEqual([{ z: 3 }]);
    await instance.$stopBridge?.();
  });
});

describe('$stopBridge', () => {
  it('stops a started bridge and clears the handle so a second stop is a no-op', async () => {
    const transport = memoryTransport();

    @EventBridge({ transport: () => transport, autoStart: false })
    class StoppableBridge {
      @Outbound('stoppable.event', { topic: 'stoppable' })
      out!: undefined;
    }

    const instance = useContainer().resolve(StoppableBridge) as BridgedInstance;
    const handle = await instance.$startBridge?.();
    expect(handle?.started).toBe(true);

    await instance.$stopBridge?.();
    expect(handle?.started).toBe(false);

    // Calling stop again with no active handle should not throw.
    await instance.$stopBridge?.();
  });
});

describe('autoStart failure handling', () => {
  it('logs via console.error when $startBridge rejects during the queued autoStart', async () => {
    const errorSpy = mock(() => {});
    const original = console.error;
    console.error = errorSpy;

    const failingTransport: EventTransport = {
      async start() {
        throw new Error('start failed');
      },
      async publish() {},
      async subscribe() {
        return () => {};
      },
    };

    @EventBridge({ transport: () => failingTransport })
    class AutoFailBridge {
      @Outbound('autofail.event', { topic: 'autofail' })
      out!: undefined;
    }

    useContainer().resolve(AutoFailBridge);
    await Bun.sleep(20);

    expect(errorSpy).toHaveBeenCalled();
    console.error = original;
  });
});

describe('startEventBridges - registry/container resolution edge cases', () => {
  it('prefers the source constructor when the registry entry itself is unregistered (line: ctor = source)', async () => {
    // This scenario cannot arise through the public @EventBridge decorator alone
    // (its own bookkeeping always keeps a "no source" registry entry in front of
    // the loop, per registry insertion order). We exercise the registry's public
    // API directly with a tiny explicit constructor to reach this defensive branch
    // in startEventBridges(), matching how it protects against custom registries.
    registry.clear();
    useContainer().clear();

    let startedWith: string | undefined;
    class SourceImpl {
      async $startBridge() {
        startedWith = 'source';
        return { started: true, async start() {}, async stop() {} };
      }
    }
    class BridgedRef {}
    (BridgedRef as unknown as { __diEventsSource?: unknown }).__diEventsSource = SourceImpl;

    registry.addTarget(BridgedRef);
    useContainer().register(SourceImpl, { singleton: true });

    const handles = await startEventBridges();

    expect(startedWith).toBe('source');
    expect(handles).toHaveLength(1);
  });

  it('falls back to a sibling registered constructor sharing the same source (loop over other entries)', async () => {
    registry.clear();
    useContainer().clear();

    class SharedSource {}
    class Bridged1 {}
    class Bridged2 {
      async $startBridge() {
        return { started: true, async start() {}, async stop() {} };
      }
    }
    (Bridged1 as unknown as { __diEventsSource?: unknown }).__diEventsSource = SharedSource;
    (Bridged2 as unknown as { __diEventsSource?: unknown }).__diEventsSource = SharedSource;

    // Only Bridged1's entry drives the loop; Bridged2 must be discovered as a
    // sibling entry (matching SOURCE_KEY) that IS registered in the container.
    registry.addTarget(Bridged1);
    registry.addTarget(Bridged2);
    useContainer().register(Bridged2, { singleton: true });

    const handles = await startEventBridges();
    expect(handles).toHaveLength(1);
  });

  it('registers a resolvable target with the container when not yet registered', async () => {
    registry.clear();
    useContainer().clear();

    class Unregistered {}
    registry.addTarget(Unregistered);

    expect(useContainer().has(Unregistered)).toBe(false);
    const handles = await startEventBridges();
    expect(useContainer().has(Unregistered)).toBe(true);
    // No $startBridge on this plain class, so no handle is produced.
    expect(handles).toEqual([]);
  });

  it('starts bridges using a transport supplied directly to startEventBridges()', async () => {
    const transport = memoryTransport();
    const seen: unknown[] = [];
    await transport.start?.();
    await transport.subscribe('direct-topic', async (msg, ack) => {
      seen.push(msg.payload);
      ack.ack();
    });

    @EventBridge({ autoStart: false })
    class DirectTransportBridge {
      @Outbound('direct.event', { topic: 'direct-topic' })
      out!: undefined;
    }
    void DirectTransportBridge;

    const handles = await startEventBridges({ transport: () => transport });
    expect(handles).toHaveLength(1);

    useContainer().emit('direct.event', { d: 1 });
    await Bun.sleep(10);
    expect(seen).toEqual([{ d: 1 }]);
  });
});
