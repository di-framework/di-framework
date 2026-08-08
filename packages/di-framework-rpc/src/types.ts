export type RpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: RpcId;
  error: JsonRpcErrorObject;
}

export type RpcStreamStatus = 'next' | 'complete' | 'error';

export interface JsonRpcStreamNextSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  stream: 'next';
  result?: unknown;
  params?: unknown;
}

export interface JsonRpcStreamComplete {
  jsonrpc: '2.0';
  id: RpcId;
  stream: 'complete';
  result?: unknown;
}

export interface JsonRpcStreamError {
  jsonrpc: '2.0';
  id: RpcId;
  stream: 'error';
  error: JsonRpcErrorObject;
}

export type JsonRpcStreamFrame =
  | JsonRpcStreamNextSuccess
  | JsonRpcStreamComplete
  | JsonRpcStreamError;

export type JsonRpcCall = JsonRpcRequest | JsonRpcNotification;
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure | JsonRpcStreamFrame;
export type JsonRpcPayload = JsonRpcCall | JsonRpcResponse | JsonRpcCall[] | JsonRpcResponse[];

export type RpcTransportHandler = (payload: unknown) => void | Promise<void>;
export type RpcUnsubscribe = () => void | Promise<void>;

/** Duplex frame transport used by the transport-neutral client and server. */
export interface RpcTransport {
  send(payload: unknown): Promise<void>;
  subscribe(handler: RpcTransportHandler): RpcUnsubscribe;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous classes
export type RpcConstructor<T = any> = new (...args: any[]) => T;
export type RpcTypeFactory<T = unknown> = () => RpcConstructor<T>;

export interface RpcStreamWrapper<T = unknown> {
  __rpcStream: true;
  factory: RpcTypeFactory<T>;
}

export enum MethodKind {
  Unary = 'unary',
  ServerStreaming = 'server_streaming',
  ClientStreaming = 'client_streaming',
  BiDiStreaming = 'bidi_streaming',
}

export type RpcScalarType = 'string' | 'bool' | 'int32' | 'int64' | 'double' | 'bytes';

export interface RpcFieldOptions {
  number: number;
  type?: RpcScalarType | RpcTypeFactory;
  repeated?: boolean;
}

export interface RpcFieldMetadata extends RpcFieldOptions {
  propertyKey: string;
}

export interface RpcMessageMetadata {
  target: RpcConstructor;
  name: string;
  fields: RpcFieldMetadata[];
}

export interface RpcMethodOptions {
  // biome-ignore lint/suspicious/noExplicitAny: accepts factories or stream wrappers
  input: RpcTypeFactory | RpcStreamWrapper | (() => RpcStreamWrapper | RpcConstructor<any>);
  // biome-ignore lint/suspicious/noExplicitAny: accepts factories or stream wrappers
  output?: RpcTypeFactory | RpcStreamWrapper | (() => RpcStreamWrapper | RpcConstructor<any>);
  name?: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

export interface RpcNotifyOptions {
  input: RpcTypeFactory;
  name?: string;
}

export interface RpcMethodMetadata {
  propertyKey: string | symbol;
  name: string;
  input: RpcTypeFactory;
  output?: RpcTypeFactory;
  notification: boolean;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

export interface RpcServiceOptions {
  package: string;
  name?: string;
  singleton?: boolean;
  container?: unknown;
  transport?: RpcTransport | (() => RpcTransport);
  autoStart?: boolean;
}

export interface RpcServiceMetadata {
  target: RpcConstructor;
  package: string;
  name: string;
  methods: RpcMethodMetadata[];
}

export interface RpcContainer {
  has?(target: unknown): boolean;
  register?(target: unknown, options?: { singleton?: boolean }): void;
  resolve(target: unknown): unknown;
  on?(event: string, handler: (payload: unknown) => void): RpcUnsubscribe;
}

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RpcInterceptorContext {
  method: string;
  params: unknown;
  id?: string | number;
  signal?: AbortSignal;
}

/** Client-side interceptor: wrap a single outbound call (or notification). */
export type RpcInterceptor = (
  context: RpcInterceptorContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface RpcServerInterceptorContext {
  method: string;
  params: unknown;
  id?: string | number;
  service: RpcServiceMetadata;
  methodMeta: RpcMethodMetadata;
}

/** Server-side interceptor: wrap handler invocation before JSON-RPC framing. */
export type RpcServerInterceptor = (
  context: RpcServerInterceptorContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface CreateRpcServerOptions {
  transport: RpcTransport;
  container?: RpcContainer;
  onError?: (error: unknown) => void;
  interceptors?: readonly RpcServerInterceptor[];
}

export interface RpcServerHandle {
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RpcServiceHost {
  $startRpc(): Promise<RpcServerHandle>;
  $stopRpc(): Promise<void>;
}

type RpcFunction = (...args: never[]) => unknown;

type MapInput<I> = I extends AsyncIterable<infer In> ? AsyncIterable<In> | Iterable<In> : I;

type MapReturn<R> = R extends AsyncIterable<infer Out> ? AsyncIterable<Out> : Promise<Awaited<R>>;

type RpcMethodClient<T> = {
  [K in keyof T as T[K] extends RpcFunction ? K : never]: T[K] extends (input: infer I) => infer R
    ? (input: MapInput<I>, options?: RpcCallOptions) => MapReturn<R>
    : T[K] extends () => infer R
      ? (options?: RpcCallOptions) => MapReturn<R>
      : never;
};

/** Preserve service method names/arguments while making every result awaitable. */
export type RpcClient<T> = RpcMethodClient<T> & {
  /**
   * Collect calls into one JSON-RPC batch. Methods on the builder return
   * promises that settle when the batch response arrives.
   */
  $batch<const TCalls extends readonly Promise<unknown>[]>(
    build: (rpc: RpcMethodClient<T>) => TCalls,
  ): Promise<{ -readonly [K in keyof TCalls]: Awaited<TCalls[K]> }>;
};

export interface CreateRpcClientOptions {
  /** Fully qualified service name (`package.Service`). */
  service?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  interceptors?: readonly RpcInterceptor[];
}
