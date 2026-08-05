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
import { isJsonRpcCall, JSON_RPC_ERRORS, rpcFailure } from '../codec.ts';
import { isRpcAppError, RPC_CONNECT_CODES, type RpcConnectCode } from '../errors.ts';
import registry, { type RpcRegistry } from '../registry.ts';
import { compileConnectSchema } from '../schema/connect.ts';
import { hydrateRpcMessage, rpcMessageToJson } from '../schema/messages.ts';
import type {
  JsonRpcCall,
  JsonRpcResponse,
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

/** Register one Connect/gRPC unary endpoint for every decorated @RpcMethod. */
export function createGrpcRoutes(options: CreateGrpcRoutesOptions = {}) {
  const source = options.registry ?? registry;
  const container = options.container ?? (useContainer() as RpcContainer);
  const interceptors = options.interceptors ?? [];
  const compiled = compileConnectSchema(source);

  return (router: ConnectRouter): void => {
    for (const [service, descriptor] of compiled.services) {
      const implementation: Record<
        string,
        (request: Record<string, unknown>) => Promise<Record<string, unknown>>
      > = {};
      for (const methodDescriptor of descriptor.methods) {
        const method = service.methods.find(
          (candidate) => candidate.name === methodDescriptor.name,
        );
        if (!method) continue;
        implementation[methodDescriptor.localName] = async (request) => {
          try {
            const input = hydrateRpcMessage(method.input(), request, source);
            const instance = container.resolve(service.target) as Record<string | symbol, unknown>;
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
                (handler as (value: unknown) => unknown).call(instance, input) as Promise<unknown>,
            );
            return method.output ? rpcMessageToJson(method.output(), output, source) : {};
          } catch (error) {
            throw toConnectError(error);
          }
        };
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
      ...options.connect,
    } as ConnectTransportOptions);
  const handlers = new Set<RpcTransportHandler>();

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
        (input: Record<string, unknown>) => Promise<unknown>
      >;
      const invokeMethod = client[match.descriptor.localName];
      if (!invokeMethod) throw new Error(`${call.method} is not callable`);
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
      const calls = Array.isArray(payload) ? payload : [payload];
      if (!calls.every(isJsonRpcCall)) {
        throw new Error('gRPC transport accepts JSON-RPC calls only');
      }
      const responses = (await Promise.all(calls.map(invoke))).filter(
        (response): response is JsonRpcResponse => response !== undefined,
      );
      if (responses.length === 0) return;
      const output = Array.isArray(payload) ? responses : responses[0];
      if (!output) return;
      await Promise.all([...handlers].map((handler) => handler(output)));
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      handlers.clear();
    },
  };
}
