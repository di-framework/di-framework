# @di-framework/events

Bridge the core in-process `@Publisher` / `@Subscriber` bus to external brokers (Kafka, NATS) through a pluggable `EventTransport`. Domain services stay on `@di-framework/core`; this package is the wire.

## Features

- **Same bus, external brokers**: outbound routes publish container events to topics; inbound routes emit broker messages back onto the container (so `@Subscriber` and GraphQL subscriptions keep working).
- **Decorator routes**: `@EventBridge`, `@Outbound`, `@Inbound` declare the map in code.
- **Imperative API**: `createEventBridge({ transport, routes })` for tests and scripts.
- **In-memory transport**: always available, no peers — used in unit tests and local runs.
- **Optional peers**: `kafkajs` and `nats` behind `@di-framework/events/kafka` and `@di-framework/events/nats`.
- **At-least-once**: adapters expose `ack` / `nack`; durability details are broker-specific.

## Installation

```bash
bun add @di-framework/events @di-framework/core
# optional brokers
bun add kafkajs   # for @di-framework/events/kafka
bun add nats      # for @di-framework/events/nats
```

## Quick start (in-memory)

```typescript
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';
import { useContainer } from '@di-framework/core/container';
import {
  createEventBridge,
  memoryTransport,
} from '@di-framework/events';

@Container()
class OrderService {
  @Publisher('order.placed')
  place(id: string) {
    return { id };
  }
}

@Container()
class FulfillmentService {
  @Subscriber('order.placed')
  onPlaced(payload: any) {
    console.log('order', payload.result ?? payload);
  }
}

const transport = memoryTransport();
const bridge = createEventBridge({
  transport,
  routes: {
    outbound: [{ event: 'order.placed', topic: 'orders' }],
    inbound: [{ topic: 'payments', event: 'payment.captured' }],
  },
});

await bridge.start();

const orders = useContainer().resolve(OrderService);
useContainer().resolve(FulfillmentService);
orders.place('o1'); // local subscriber + outbound publish to "orders"

await bridge.stop();
```

Outbound payloads default to unwrapping the `@Publisher` envelope (`result`), matching GraphQL subscriptions. Inbound emits the decoded payload as-is.

## Decorator routes

```typescript
import { EventBridge, Outbound, Inbound, memoryTransport } from '@di-framework/events';

@EventBridge({ transport: () => memoryTransport() })
class OrderEvents {
  @Outbound('order.placed', {
    topic: 'orders',
    key: (p: any) => p.result?.id,
  })
  outboundOrders!: void;

  @Inbound({ topic: 'payments.captured', event: 'payment.captured' })
  inboundPayments!: void;
}

// autoStart (default) starts the bridge on resolve:
useContainer().resolve(OrderEvents);

// or disable autoStart and call:
// await startEventBridges();
```

Inject a shared transport instead of passing one in options:

```typescript
container.registerFactory('EventTransport', () => memoryTransport(), { singleton: true });

@EventBridge() // resolves token "EventTransport"
class OrderEvents { /* ... */ }
```

## Kafka

```typescript
import { createEventBridge } from '@di-framework/events';
import { kafkaTransport } from '@di-framework/events/kafka';

const transport = kafkaTransport({
  client: { clientId: 'my-app', brokers: ['localhost:9092'] },
  groupId: 'my-app-consumers',
});

const bridge = createEventBridge({
  transport,
  routes: {
    outbound: [{ event: 'order.placed', topic: 'orders' }],
    inbound: [{ topic: 'orders', event: 'order.placed' }],
  },
});
await bridge.start();
```

Topic creation is left to operators. Delivery is at-least-once via the consumer group.

## NATS

```typescript
import { natsTransport } from '@di-framework/events/nats';

const transport = natsTransport({
  servers: 'nats://127.0.0.1:4222',
  // jetstream: true,
  // durable: 'my-consumer',
});
```

Core NATS is the default. Set `jetstream: true` (and usually `durable`) for durable consumers.

## Inbound Middleware and Route Validation

Inbound event processing follows a deterministic execution pipeline:

1. **`filter`**: Drops unwanted messages early (`ack.ack()` without emitting).
2. **`map`**: Transforms raw message payload.
3. **`validate`**: Validates/transforms the mapped payload. Thrown errors route to `onError` and `ack.nack({ requeue: false })`. The returned value becomes the payload for downstream middleware and event emission.
4. **Bridge-level middleware**: Functions defined on `@EventBridge` or `createEventBridge({ middleware })`, executed in declaration order.
5. **Route-level middleware**: Functions defined on `@Inbound` or route options, executed in declaration order.
6. **Container emit**: Emits the validated/transformed payload onto the container event bus (`container.emit(route.event, payload)`).
7. **Acknowledge**: Calls `ack.ack()`.

### Validation Reuse

Use the `validate` hook on `@Inbound` or route options to sanitize and type-check incoming payloads:

```typescript
import { Inbound, EventBridge } from '@di-framework/events';
import { z } from 'zod';

const PaymentCapturedSchema = z.object({
  paymentId: z.string(),
  amount: z.number().positive(),
  currency: z.string().length(3),
});

function validateWith<T>(schema: z.ZodType<T>) {
  return (payload: unknown) => schema.parse(payload);
}

@EventBridge()
class PaymentEvents {
  @Inbound({
    topic: 'payments.captured',
    event: 'payment.captured',
    validate: validateWith(PaymentCapturedSchema),
  })
  inboundPayments!: void;
}
```

### Idempotency-Claim Middleware

Middleware functions receive an `InboundMiddlewareContext` (`{ message, route, payload, next }`). If a middleware completes without calling `next()`, execution short-circuits: container emission is bypassed, and the message is acknowledged (`ack.ack()`).

```typescript
import { EventBridge, Inbound, type InboundMiddleware } from '@di-framework/events';

const processedIds = new Set<string>();

const idempotencyMiddleware: InboundMiddleware = async (ctx) => {
  if (processedIds.has(ctx.message.id)) {
    // Already handled: short-circuit pipeline & ack message
    return;
  }
  processedIds.add(ctx.message.id);
  await ctx.next();
};

@EventBridge({ middleware: [idempotencyMiddleware] })
class OrderEvents {
  @Inbound({ topic: 'orders.placed', event: 'order.placed' })
  inboundOrders!: void;
}
```

## Loop suppression

When the same process both publishes and consumes the same event/topic pair, inbound emits temporarily suppress outbound republishing so a single-process echo cannot spin forever. Local `@Subscriber` handlers still see the original `@Publisher` event; a remote echo would arrive as a second emit in a multi-process deployment.

## Lifecycle

- `bridge.start()` connects the transport and attaches routes.
- `bridge.stop()` and `container.clear()` tear the bridge down (same idea as `@Cron`).
- Optional `onError` receives `{ direction, topic, event, error }`.

## API

| Export | |
| --- | --- |
| `createEventBridge` | Imperative bridge |
| `memoryTransport` | In-process transport |
| `JsonCodec` | Default JSON codec |
| `EventBridge` / `Outbound` / `Inbound` | Route decorators |
| `startEventBridges` | Resolve + start all registered bridges |
| `@di-framework/events/kafka` | `kafkaTransport` |
| `@di-framework/events/nats` | `natsTransport` |

## Non-goals (v1)

Transactional outbox/inbox, schema registry / Avro, request-reply, and additional brokers (Redis Streams, SQS, …). The `EventTransport` interface is the extension point.

## License

MIT
