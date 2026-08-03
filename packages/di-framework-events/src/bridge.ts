import { useContainer } from '@di-framework/core/container';
import type {
  CreateEventBridgeOptions,
  EventBridgeContainer,
  EventBridgeHandle,
  EventMessage,
  InboundRoute,
  OutboundRoute,
} from './types.ts';

/**
 * Unwrap the core `@Publisher` envelope to its `result`, matching GraphQL
 * subscription behaviour. Non-envelope payloads pass through unchanged.
 */
export function unwrapPublisherPayload(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === 'object' &&
    'className' in payload &&
    'methodName' in payload &&
    'result' in payload
  ) {
    return (payload as { result: unknown }).result;
  }
  return payload;
}

function newMessageId(): string {
  return crypto.randomUUID();
}

/**
 * Bridge a DI container event bus to an {@link EventTransport}.
 *
 * Outbound: container emit → topic publish.
 * Inbound: broker message → container emit (feeds `@Subscriber` / GraphQL).
 *
 * Outbound publishing is suppressed while handling inbound emits so a
 * single-process echo of the same event/topic pair cannot loop forever.
 */
export function createEventBridge(options: CreateEventBridgeOptions): EventBridgeHandle {
  const container: EventBridgeContainer = options.container ?? useContainer();
  const transport = options.transport;
  const outbound = options.routes.outbound ?? [];
  const inbound = options.routes.inbound ?? [];
  const onError =
    options.onError ??
    ((ctx) => {
      console.error(`[EventBridge] ${ctx.direction} ${ctx.event}↔${ctx.topic} failed`, ctx.error);
    });
  void options.codec; // reserved for bridge-level encoding hooks; adapters use their own codec

  let started = false;
  let inboundDepth = 0;
  const unsubscribers: Array<() => void | Promise<void>> = [];
  let clearUnsub: (() => void) | undefined;

  const publishOutbound = async (route: OutboundRoute, payload: unknown) => {
    if (inboundDepth > 0) return;
    if (route.filter && !route.filter(payload)) return;

    const mapped = route.map ? route.map(payload) : unwrapPublisherPayload(payload);
    const key = route.key?.(payload);
    const headers = route.headers?.(payload);

    const message: EventMessage = {
      id: newMessageId(),
      topic: route.topic,
      key,
      headers,
      payload: mapped,
      timestamp: Date.now(),
    };

    try {
      await transport.publish(message);
    } catch (error) {
      onError({ direction: 'outbound', topic: route.topic, event: route.event, error });
    }
  };

  const attachOutbound = (route: OutboundRoute) => {
    const off = container.on(route.event, (payload: unknown) => {
      void publishOutbound(route, payload);
    });
    unsubscribers.push(off);
  };

  const attachInbound = async (route: InboundRoute) => {
    const unsub = await transport.subscribe(route.topic, async (msg, ack) => {
      try {
        if (route.filter && !route.filter(msg.payload, msg)) {
          await ack.ack();
          return;
        }
        const mapped = route.map ? route.map(msg.payload, msg) : msg.payload;
        inboundDepth += 1;
        try {
          container.emit(route.event, mapped);
        } finally {
          inboundDepth -= 1;
        }
        await ack.ack();
      } catch (error) {
        onError({ direction: 'inbound', topic: route.topic, event: route.event, error });
        try {
          await ack.nack({ requeue: false });
        } catch (nackErr) {
          onError({ direction: 'inbound', topic: route.topic, event: route.event, error: nackErr });
        }
      }
    });
    unsubscribers.push(unsub);
  };

  const handle: EventBridgeHandle = {
    get started() {
      return started;
    },

    async start() {
      if (started) return;
      await transport.start?.();

      for (const route of outbound) attachOutbound(route);
      for (const route of inbound) await attachInbound(route);

      // Tear down when the container is cleared (same lifecycle idea as @Cron).
      clearUnsub = container.on('cleared', () => {
        void handle.stop();
      });

      started = true;
    },

    async stop() {
      if (!started && unsubscribers.length === 0) return;
      clearUnsub?.();
      clearUnsub = undefined;

      const pending = [...unsubscribers];
      unsubscribers.length = 0;
      for (const unsub of pending) {
        await unsub();
      }
      await transport.stop?.();
      started = false;
    },
  };

  return handle;
}
