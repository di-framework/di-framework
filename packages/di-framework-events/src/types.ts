/**
 * Wire-format message exchanged with an {@link EventTransport}.
 */
export interface EventMessage<T = unknown> {
  id: string;
  topic: string;
  key?: string;
  headers?: Record<string, string>;
  payload: T;
  timestamp?: number;
}

/** Acknowledgement handle passed to inbound transport handlers. */
export interface Ack {
  ack(): Promise<void> | void;
  nack(options?: { requeue?: boolean }): Promise<void> | void;
}

export type Unsubscribe = () => void | Promise<void>;

/**
 * Broker-agnostic transport. Kafka, NATS, and in-memory adapters implement this.
 * Delivery is at-least-once; adapters document durability specifics.
 */
export interface EventTransport {
  publish(message: EventMessage): Promise<void>;
  subscribe(
    topic: string,
    handler: (msg: EventMessage, ack: Ack) => Promise<void>,
  ): Promise<Unsubscribe>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** Encode / decode payloads for the wire. */
export interface EventCodec {
  encode(payload: unknown): Uint8Array | string;
  decode(data: Uint8Array | string): unknown;
}

export type OutboundMapFn = (payload: unknown) => unknown;
export type OutboundKeyFn = (payload: unknown) => string | undefined;
export type OutboundFilterFn = (payload: unknown) => boolean;
export type InboundMapFn = (payload: unknown, message: EventMessage) => unknown;
export type InboundFilterFn = (payload: unknown, message: EventMessage) => boolean;
export type InboundValidateFn = (
  payload: unknown,
  message: EventMessage,
) => unknown | Promise<unknown>;

export interface InboundMiddlewareContext<T = unknown> {
  message: EventMessage;
  route: InboundRoute;
  payload: T;
  next: () => Promise<void> | void;
}

export type InboundMiddleware<T = unknown> = (
  ctx: InboundMiddlewareContext<T>,
) => Promise<void> | void;

export interface OutboundRoute {
  event: string;
  topic: string;
  /** Defaults to unwrapping the @Publisher envelope (`result`). */
  map?: OutboundMapFn;
  key?: OutboundKeyFn;
  filter?: OutboundFilterFn;
  headers?: (payload: unknown) => Record<string, string> | undefined;
}

export interface InboundRoute {
  topic: string;
  event: string;
  map?: InboundMapFn;
  filter?: InboundFilterFn;
  validate?: InboundValidateFn;
  middleware?: InboundMiddleware | InboundMiddleware[];
}

export interface EventBridgeRoutes {
  outbound?: OutboundRoute[];
  inbound?: InboundRoute[];
}

export type EventBridgeErrorContext = {
  direction: 'inbound' | 'outbound';
  topic: string;
  event: string;
  error: unknown;
};

export interface CreateEventBridgeOptions {
  /** DI container whose bus is bridged. Defaults to `useContainer()`. */
  container?: EventBridgeContainer;
  transport: EventTransport;
  routes: EventBridgeRoutes;
  codec?: EventCodec;
  /** Called when publish/consume handling fails. Defaults to console.error + nack. */
  onError?: (ctx: EventBridgeErrorContext) => void;
  middleware?: InboundMiddleware | InboundMiddleware[];
}

/** Minimal container surface used by the bridge (avoids tight coupling). */
export interface EventBridgeContainer {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
  clear?: () => void;
  has?(serviceClass: unknown): boolean;
  register?(serviceClass: unknown, options?: { singleton?: boolean }): void;
  resolve?(serviceClass: unknown): unknown;
}

export interface EventBridgeHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly started: boolean;
}

export interface OutboundDecoratorOptions {
  topic: string;
  map?: OutboundMapFn;
  key?: OutboundKeyFn;
  filter?: OutboundFilterFn;
  headers?: (payload: unknown) => Record<string, string> | undefined;
}

export interface InboundDecoratorOptions {
  topic: string;
  event: string;
  map?: InboundMapFn;
  filter?: InboundFilterFn;
  validate?: InboundValidateFn;
  middleware?: InboundMiddleware | InboundMiddleware[];
}

export type EventTransportConstructor = abstract new () => EventTransport;

export interface EventBridgeDecoratorOptions {
  singleton?: boolean;
  /** DI container instance. Defaults to the global container. */
  container?: unknown;
  /** Transport instance or factory. Resolved from DI token when omitted. */
  transport?: EventTransport | (() => EventTransport);
  /** DI token used when `transport` is omitted. Defaults to `'EventTransport'`. */
  transportToken?: string | EventTransportConstructor;
  codec?: EventCodec;
  onError?: (ctx: EventBridgeErrorContext) => void;
  /** Start the bridge when the class is resolved. Defaults to `true`. */
  autoStart?: boolean;
  middleware?: InboundMiddleware | InboundMiddleware[];
}
