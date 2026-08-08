import { type DescMethod, type Message, toJson } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type Transport as ConnectTransport,
  createClient,
} from '@connectrpc/connect';
import {
  type ConnectTransportOptions,
  connectNodeAdapter,
  createConnectTransport,
} from '@connectrpc/connect-node';
import { useContainer } from '@di-framework/core/container';
import { isJsonRpcCall, isJsonRpcStreamFrame, JSON_RPC_ERRORS, rpcFailure } from '../codec.ts';
import { isAsyncIterable, unwrapStream } from '../decorators.ts';
import { PushStream } from '../dispatcher.ts';
import { isRpcAppError, RPC_CONNECT_CODES, type RpcConnectCode } from '../errors.ts';
import registry, { type RpcRegistry } from '../registry.ts';
import { compileConnectSchema } from '../schema/connect.ts';
import { hydrateRpcMessage, rpcMessageToJson } from '../schema/messages.ts';
import type {
  JsonRpcCall,
  JsonRpcResponse,
  JsonRpcStreamComplete,
  JsonRpcStreamError,
  JsonRpcStreamNextSuccess,
  RpcContainer,
  RpcServerInterceptor,
  RpcTransport,
  RpcTransportHandler,
} from '../types.ts';

const CONNECT_CODE_MAP: Record<RpcConnectCode, Code> = {
  [RPC_CONNECT_CODES.CANCELED]: Code.Canceled,
  [RPC_CONNECT_CODES.UNKNOWN]: Code.Unknown,
  [RPC_CONNECT_CODES.INVALID_ARGUMENT]: Code.InvalidArgument,
  [RPC_CONNECT_CODES.DEADLINE_EXCEEDED]: Code.DeadlineExceeded,
  [RPC_CONNECT_CODES.NOT_FOUND]: Code.NotFound,
  [RPC_CONNECT_CODES.ALREADY_EXISTS]: Code.AlreadyExists,
  [RPC_CONNECT_CODES.PERMISSION_DENIED]: Code.PermissionDenied,
  [RPC_CONNECT_CODES.RESOURCE_EXHAUSTED]: Code.ResourceExhausted,
  [RPC_CONNECT_CODES.FAILED_PRECONDITION]: Code.FailedPrecondition,
  [RPC_CONNECT_CODES.ABORTED]: Code.Aborted,
  [RPC_CONNECT_CODES.OUT_OF_RANGE]: Code.OutOfRange,
  [RPC_CONNECT_CODES.UNIMPLEMENTED]: Code.Unimplemented,
  [RPC_CONNECT_CODES.INTERNAL]: Code.Internal,
  [RPC_CONNECT_CODES.UNAVAILABLE]: Code.Unavailable,
  [RPC_CONNECT_CODES.DATA_LOSS]: Code.DataLoss,
  [RPC_CONNECT_CODES.UNAUTHENTICATED]: Code.Unauthenticated,
};

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (isRpcAppError(error)) {
    return new ConnectError(error.message, CONNECT_CODE_MAP[error.connectCode] ?? Code.Internal);
  }
  return new ConnectError(error instanceof Error ? error.message : String(error), Code.Internal);
}

function composeServerInterceptors(
  interceptors: readonly RpcServerInterceptor[],
  context: Parameters<RpcServerInterceptor>[0],
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  let index = -1;
  const dispatch = async (current: number): Promise<unknown> => {
    if (current <= index) throw new Error('RPC interceptor called next() multiple times');
    index = current;
    const interceptor = interceptors[current];
    if (!interceptor) return invoke();
    return interceptor(context, () => dispatch(current + 1));
  };
  return dispatch(0);
}

export interface CreateGrpcRoutesOptions {
  registry?: RpcRegistry;
  container?: RpcContainer;
  interceptors?: readonly RpcServerInterceptor[];
}

/** Register Connect/gRPC unary and streaming endpoints for decorated @RpcMethod definitions. */
export function createGrpcRoutes(options: CreateGrpcRoutesOptions = {}) {
  const source = options.registry ?? registry;
  const container = options.container ?? (useContainer() as RpcContainer);
  const interceptors = options.interceptors ?? [];
  const compiled = compileConnectSchema(source);

  return (router: ConnectRouter): void => {
    for (const [service, descriptor] of compiled.services) {
      // biome-ignore lint/suspicious/noExplicitAny: Connect router maps flexible handler functions
      const implementation: Record<string, any> = {};
      for (const methodDescriptor of descriptor.methods) {
        const method = service.methods.find(
          (candidate) => candidate.name === methodDescriptor.name,
        );
        if (!method) continue;

        const kind = methodDescriptor.methodKind;
        const serverStreaming =
          kind === 'server_streaming' ||
          kind === 'bidi_streaming' ||
          method.serverStreaming === true;
        const clientStreaming =
          kind === 'client_streaming' ||
          kind === 'bidi_streaming' ||
          method.clientStreaming === true;

        if (serverStreaming && !clientStreaming) {
          // Server-Streaming
          implementation[methodDescriptor.localName] = async function* (
            request: Record<string, unknown>,
            context: { signal: AbortSignal },
          ) {
            try {
              const input = hydrateRpcMessage(unwrapStream(method.input()), request, source);
              const instance = container.resolve(service.target) as Record<
                string | symbol,
                unknown
              >;
              const handler = instance[method.propertyKey];
              if (typeof handler !== 'function') {
                throw new ConnectError(
                  `${descriptor.typeName}/${method.name} is not callable`,
                  Code.Internal,
                );
              }
              const rawResult = await composeServerInterceptors(
                interceptors,
                {
                  method: `${service.package}.${service.name}/${method.name}`,
                  params: request,
                  service,
                  methodMeta: method,
                },
                () =>
                  (handler as (value: unknown) => unknown).call(
                    instance,
                    input,
                  ) as Promise<unknown>,
              );
              if (isAsyncIterable(rawResult)) {
                const outputMsg = method.output ? unwrapStream(method.output()) : undefined;
                for await (const item of rawResult as AsyncIterable<unknown>) {
                  if (context.signal.aborted) break;
                  const finalItem = await composeServerInterceptors(
                    interceptors,
                    {
                      method: `${service.package}.${service.name}/${method.name}`,
                      params: item,
                      service,
                      methodMeta: method,
                    },
                    async () => item,
                  );
                  yield outputMsg
                    ? rpcMessageToJson(outputMsg, finalItem, source)
                    : (finalItem as Record<string, unknown>);
                }
              }
            } catch (error) {
              throw toConnectError(error);
            }
          };
        } else if (!serverStreaming && clientStreaming) {
          // Client-Streaming
          implementation[methodDescriptor.localName] = async (
            requests: AsyncIterable<Record<string, unknown>>,
            context: { signal: AbortSignal },
          ) => {
            try {
              const instance = container.resolve(service.target) as Record<
                string | symbol,
                unknown
              >;
              const handler = instance[method.propertyKey];
              if (typeof handler !== 'function') {
                throw new ConnectError(
                  `${descriptor.typeName}/${method.name} is not callable`,
                  Code.Internal,
                );
              }
              const inputMsg = unwrapStream(method.input());
              const outputMsg = method.output ? unwrapStream(method.output()) : undefined;

              async function* hydratedRequests() {
                for await (const req of requests) {
                  if (context.signal.aborted) break;
                  yield hydrateRpcMessage(inputMsg, req, source);
                }
              }

              const output = await composeServerInterceptors(
                interceptors,
                {
                  method: `${service.package}.${service.name}/${method.name}`,
                  params: {},
                  service,
                  methodMeta: method,
                },
                () =>
                  (handler as (value: unknown) => unknown).call(
                    instance,
                    hydratedRequests(),
                  ) as Promise<unknown>,
              );
              return outputMsg ? rpcMessageToJson(outputMsg, output, source) : {};
            } catch (error) {
              throw toConnectError(error);
            }
          };
        } else if (serverStreaming && clientStreaming) {
          // Bi-Directional Streaming
          implementation[methodDescriptor.localName] = async function* (
            requests: AsyncIterable<Record<string, unknown>>,
            context: { signal: AbortSignal },
          ) {
            try {
              const instance = container.resolve(service.target) as Record<
                string | symbol,
                unknown
              >;
              const handler = instance[method.propertyKey];
              if (typeof handler !== 'function') {
                throw new ConnectError(
                  `${descriptor.typeName}/${method.name} is not callable`,
                  Code.Internal,
                );
              }
              const inputMsg = unwrapStream(method.input());
              const outputMsg = method.output ? unwrapStream(method.output()) : undefined;

              async function* hydratedRequests() {
                for await (const req of requests) {
                  if (context.signal.aborted) break;
                  yield hydrateRpcMessage(inputMsg, req, source);
                }
              }

              const rawResult = await composeServerInterceptors(
                interceptors,
                {
                  method: `${service.package}.${service.name}/${method.name}`,
                  params: {},
                  service,
                  methodMeta: method,
                },
                () =>
                  (handler as (value: unknown) => unknown).call(
                    instance,
                    hydratedRequests(),
                  ) as Promise<unknown>,
              );

              if (isAsyncIterable(rawResult)) {
                for await (const item of rawResult as AsyncIterable<unknown>) {
                  if (context.signal.aborted) break;
                  const finalItem = await composeServerInterceptors(
                    interceptors,
                    {
                      method: `${service.package}.${service.name}/${method.name}`,
                      params: item,
                      service,
                      methodMeta: method,
                    },
                    async () => item,
                  );
                  yield outputMsg
                    ? rpcMessageToJson(outputMsg, finalItem, source)
                    : (finalItem as Record<string, unknown>);
                }
              }
            } catch (error) {
              throw toConnectError(error);
            }
          };
        } else {
          // Unary
          implementation[methodDescriptor.localName] = async (request: Record<string, unknown>) => {
            try {
              const input = hydrateRpcMessage(unwrapStream(method.input()), request, source);
              const instance = container.resolve(service.target) as Record<
                string | symbol,
                unknown
              >;
              const handler = instance[method.propertyKey];
              if (typeof handler !== 'function') {
                throw new ConnectError(
                  `${descriptor.typeName}/${method.name} is not callable`,
                  Code.Internal,
                );
              }
              const output = await composeServerInterceptors(
                interceptors,
                {
                  method: `${service.package}.${service.name}/${method.name}`,
                  params: request,
                  service,
                  methodMeta: method,
                },
                () =>
                  (handler as (value: unknown) => unknown).call(
                    instance,
                    input,
                  ) as Promise<unknown>,
              );
              return method.output
                ? rpcMessageToJson(unwrapStream(method.output()), output, source)
                : {};
            } catch (error) {
              throw toConnectError(error);
            }
          };
        }
      }
      router.service(descriptor, implementation as never);
    }
  };
}

export interface CreateGrpcHandlerOptions extends CreateGrpcRoutesOptions {
  requestPathPrefix?: string;
}

/** Node/Bun-compatible Connect, gRPC-Web, and native gRPC request handler. */
export function createGrpcHandler(
  options: CreateGrpcHandlerOptions = {},
): ReturnType<typeof connectNodeAdapter> {
  return connectNodeAdapter({
    routes: createGrpcRoutes(options),
    requestPathPrefix: options.requestPathPrefix,
  });
}

export interface GrpcTransportOptions {
  baseUrl?: string;
  /** Supply a router transport for tests or a custom Connect transport. */
  transport?: ConnectTransport;
  connect?: Omit<ConnectTransportOptions, 'baseUrl'>;
  registry?: RpcRegistry;
}

function methodForCall(
  call: JsonRpcCall,
  source: RpcRegistry,
  schema: ReturnType<typeof compileConnectSchema>,
) {
  const match = source.findMethod(call.method);
  if (!match) return undefined;
  const service = schema.services.get(match.service);
  const method = service?.methods.find((candidate) => candidate.name === match.method.name);
  return service && method ? { ...match, service, descriptor: method } : undefined;
}

function responseJson(method: DescMethod, response: unknown): unknown {
  return toJson(method.output, response as Message);
}

function connectCodeToJsonRpc(code: Code): number {
  switch (code) {
    case Code.InvalidArgument:
    case Code.OutOfRange:
      return JSON_RPC_ERRORS.INVALID_PARAMS;
    case Code.NotFound:
    case Code.Unimplemented:
      return JSON_RPC_ERRORS.METHOD_NOT_FOUND;
    case Code.Canceled:
    case Code.DeadlineExceeded:
      return JSON_RPC_ERRORS.SERVER;
    default:
      return JSON_RPC_ERRORS.SERVER;
  }
}

/**
 * Adapt per-method Connect/gRPC calls to the common RpcTransport client surface.
 * Each JSON-RPC method name maps directly to `/package.Service/Method`.
 */
export function grpcTransport(options: GrpcTransportOptions): RpcTransport {
  const source = options.registry ?? registry;
  const schema = compileConnectSchema(source);
  const connectTransport =
    options.transport ??
    createConnectTransport({
      baseUrl: options.baseUrl ?? 'http://localhost',
      httpVersion: '1.1',
      ...options.connect,
    } as ConnectTransportOptions);
  const handlers = new Set<RpcTransportHandler>();
  const activeSessions = new Map<string | number, PushStream<Record<string, unknown>>>();

  const emitToHandlers = async (payload: unknown) => {
    await Promise.all([...handlers].map((h) => h(payload)));
  };

  const invoke = async (call: JsonRpcCall): Promise<JsonRpcResponse | undefined> => {
    const id = 'id' in call ? call.id : undefined;
    const match = methodForCall(call, source, schema);
    if (!match) {
      return id === undefined
        ? undefined
        : rpcFailure(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found');
    }
    try {
      const client = createClient(match.service, connectTransport) as unknown as Record<
        string,
        // biome-ignore lint/suspicious/noExplicitAny: Connect client method signature
        (input: any) => any
      >;
      const invokeMethod = client[match.descriptor.localName];
      if (!invokeMethod) throw new Error(`${call.method} is not callable`);

      const kind = match.descriptor.methodKind;
      const serverStreaming =
        kind === 'server_streaming' ||
        kind === 'bidi_streaming' ||
        match.method.serverStreaming === true;
      const clientStreaming =
        kind === 'client_streaming' ||
        kind === 'bidi_streaming' ||
        match.method.clientStreaming === true;

      if (serverStreaming && !clientStreaming) {
        // Server-streaming gRPC call
        const stream = await invokeMethod((call.params ?? {}) as Record<string, unknown>);
        (async () => {
          try {
            for await (const item of stream as AsyncIterable<unknown>) {
              const nextFrame: JsonRpcStreamNextSuccess = {
                jsonrpc: '2.0',
                id: id!,
                stream: 'next',
                result: responseJson(match.descriptor, item),
              };
              await emitToHandlers(nextFrame);
            }
            const completeFrame: JsonRpcStreamComplete = {
              jsonrpc: '2.0',
              id: id!,
              stream: 'complete',
            };
            await emitToHandlers(completeFrame);
          } catch (error) {
            const connectError = ConnectError.from(error);
            const errorFrame: JsonRpcStreamError = {
              jsonrpc: '2.0',
              id: id!,
              stream: 'error',
              error: {
                code: connectCodeToJsonRpc(connectError.code),
                message: connectError.rawMessage,
              },
            };
            await emitToHandlers(errorFrame);
          }
        })();
        return undefined;
      }

      if (!serverStreaming && clientStreaming) {
        // Client-streaming gRPC call
        const pushStream = new PushStream<Record<string, unknown>>();
        if (id !== undefined) activeSessions.set(id, pushStream);
        (async () => {
          try {
            const result = await invokeMethod(pushStream);
            if (id !== undefined) activeSessions.delete(id);
            const resFrame = {
              jsonrpc: '2.0' as const,
              id: id!,
              result: responseJson(match.descriptor, result),
            };
            await emitToHandlers(resFrame);
          } catch (error) {
            if (id !== undefined) activeSessions.delete(id);
            const connectError = ConnectError.from(error);
            const failure = rpcFailure(
              id!,
              connectCodeToJsonRpc(connectError.code),
              connectError.rawMessage,
            );
            await emitToHandlers(failure);
          }
        })();
        return undefined;
      }

      if (serverStreaming && clientStreaming) {
        // Bi-Directional streaming gRPC call
        const pushStream = new PushStream<Record<string, unknown>>();
        if (id !== undefined) activeSessions.set(id, pushStream);
        const stream = await invokeMethod(pushStream);
        (async () => {
          try {
            for await (const item of stream as AsyncIterable<unknown>) {
              const nextFrame: JsonRpcStreamNextSuccess = {
                jsonrpc: '2.0',
                id: id!,
                stream: 'next',
                result: responseJson(match.descriptor, item),
              };
              await emitToHandlers(nextFrame);
            }
            const completeFrame: JsonRpcStreamComplete = {
              jsonrpc: '2.0',
              id: id!,
              stream: 'complete',
            };
            await emitToHandlers(completeFrame);
          } catch (error) {
            const connectError = ConnectError.from(error);
            const errorFrame: JsonRpcStreamError = {
              jsonrpc: '2.0',
              id: id!,
              stream: 'error',
              error: {
                code: connectCodeToJsonRpc(connectError.code),
                message: connectError.rawMessage,
              },
            };
            await emitToHandlers(errorFrame);
          } finally {
            if (id !== undefined) activeSessions.delete(id);
          }
        })();
        return undefined;
      }

      // Unary call
      const result = await invokeMethod((call.params ?? {}) as Record<string, unknown>);
      if (id === undefined) return undefined;
      return { jsonrpc: '2.0', id, result: responseJson(match.descriptor, result) };
    } catch (error) {
      if (id === undefined) return undefined;
      const connectError = ConnectError.from(error);
      return rpcFailure(id, connectCodeToJsonRpc(connectError.code), connectError.rawMessage, {
        connectCode: connectError.code,
      });
    }
  };

  return {
    async send(payload) {
      if (Array.isArray(payload)) {
        for (const item of payload) {
          if (isJsonRpcStreamFrame(item)) {
            const session = activeSessions.get(item.id!);
            if (session) {
              if (item.stream === 'next')
                session.push((item.params ?? item.result) as Record<string, unknown>);
              else if (item.stream === 'complete') session.end();
              else if (item.stream === 'error') session.error(new Error(item.error.message));
            }
          } else if (isJsonRpcCall(item)) {
            const res = await invoke(item);
            if (res !== undefined) await emitToHandlers(res);
          }
        }
        return;
      }

      if (isJsonRpcStreamFrame(payload)) {
        const session = activeSessions.get(payload.id!);
        if (session) {
          if (payload.stream === 'next')
            session.push((payload.params ?? payload.result) as Record<string, unknown>);
          else if (payload.stream === 'complete') session.end();
          else if (payload.stream === 'error') session.error(new Error(payload.error.message));
        }
        return;
      }

      if (!isJsonRpcCall(payload)) {
        throw new Error('gRPC transport accepts JSON-RPC calls only');
      }

      const res = await invoke(payload);
      if (res !== undefined) await emitToHandlers(res);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      handlers.clear();
      activeSessions.clear();
    },
  };
}
