import registry from './registry.ts';
import type {
  CreateRpcClientOptions,
  JsonRpcCall,
  JsonRpcFailure,
  JsonRpcResponse,
  RpcCallOptions,
  RpcClient,
  RpcConstructor,
  RpcInterceptor,
  RpcInterceptorContext,
  RpcTransport,
} from './types.ts';

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export class RpcRemoteError extends Error {
  override readonly name = 'RpcRemoteError';
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response;
}

function isCallOptions(value: unknown): value is RpcCallOptions {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('signal' in value || 'timeoutMs' in value)
  );
}

function onlyCallOptionKeys(value: object): boolean {
  return Object.keys(value).every((key) => key === 'signal' || key === 'timeoutMs');
}

function splitArgs(args: unknown[]): { params: unknown; callOptions?: RpcCallOptions } {
  if (args.length >= 2 && isCallOptions(args[1])) {
    return { params: args[0] ?? {}, callOptions: args[1] };
  }
  if (args.length === 1 && isCallOptions(args[0]) && onlyCallOptionKeys(args[0] as object)) {
    return { params: {}, callOptions: args[0] };
  }
  return { params: args[0] ?? {} };
}

function composeInterceptors(
  interceptors: readonly RpcInterceptor[],
  context: RpcInterceptorContext,
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

function mergeSignals(...signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup?: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return {};
  if (active.length === 1) return { signal: active[0] };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(active) };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(active.find((signal) => signal.aborted)?.reason);
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { signal: controller.signal };
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of active) signal.removeEventListener('abort', onAbort);
    },
  };
}

export function createRpcClient<T>(
  service: RpcConstructor<T>,
  transport: RpcTransport,
  options?: Omit<CreateRpcClientOptions, 'service'>,
): RpcClient<T>;
export function createRpcClient<T>(
  transport: RpcTransport,
  options: CreateRpcClientOptions & { service: string },
): RpcClient<T>;
export function createRpcClient<T>(
  serviceOrTransport: RpcConstructor<T> | RpcTransport,
  transportOrOptions: RpcTransport | (CreateRpcClientOptions & { service: string }),
  maybeOptions: Omit<CreateRpcClientOptions, 'service'> = {},
): RpcClient<T> {
  const hasServiceClass = typeof serviceOrTransport === 'function';
  const transport = (hasServiceClass ? transportOrOptions : serviceOrTransport) as RpcTransport;
  const options = (hasServiceClass ? maybeOptions : transportOrOptions) as CreateRpcClientOptions;
  const serviceMetadata = hasServiceClass ? registry.getService(serviceOrTransport) : undefined;
  if (hasServiceClass && !serviceMetadata) {
    throw new Error(`${serviceOrTransport.name} is not decorated with @RpcService`);
  }
  let serviceName = options.service;
  if (!serviceName) {
    if (!serviceMetadata) throw new Error('createRpcClient requires a service path');
    serviceName = `${serviceMetadata.package}.${serviceMetadata.name}`;
  }
  const methods = serviceMetadata?.methods;
  const interceptors = options.interceptors ?? [];
  const pending = new Map<string, PendingCall>();
  let sequence = 0;
  let started: Promise<void> | undefined;

  const ensureStarted = () => {
    started ??= Promise.resolve(transport.start?.()).then(() => undefined);
    return started;
  };

  const settle = (id: string, response: JsonRpcResponse) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (call.timeout) clearTimeout(call.timeout);
    call.onAbort?.();
    if (isFailure(response)) {
      call.reject(
        new RpcRemoteError(response.error.code, response.error.message, response.error.data),
      );
    } else {
      call.resolve(response.result);
    }
  };

  transport.subscribe((payload) => {
    const responses = Array.isArray(payload) ? payload : [payload];
    for (const candidate of responses) {
      if (!candidate || typeof candidate !== 'object' || !('id' in candidate)) continue;
      settle(String((candidate as JsonRpcResponse).id), candidate as JsonRpcResponse);
    }
  });

  const registerPending = (
    id: string,
    method: string,
    callOptions: RpcCallOptions | undefined,
  ): Promise<unknown> => {
    const timeoutMs = callOptions?.timeoutMs ?? options.timeoutMs;
    const merged = mergeSignals(options.signal, callOptions?.signal);
    return new Promise<unknown>((resolve, reject) => {
      const call: PendingCall = { resolve, reject };
      if (merged.signal) {
        if (merged.signal.aborted) {
          merged.cleanup?.();
          reject(
            merged.signal.reason instanceof Error
              ? merged.signal.reason
              : new Error(`RPC ${method} aborted`),
          );
          return;
        }
        const onAbort = () => {
          pending.delete(id);
          if (call.timeout) clearTimeout(call.timeout);
          merged.cleanup?.();
          reject(
            merged.signal?.reason instanceof Error
              ? merged.signal.reason
              : new Error(`RPC ${method} aborted`),
          );
        };
        merged.signal.addEventListener('abort', onAbort, { once: true });
        call.onAbort = () => {
          merged.signal?.removeEventListener('abort', onAbort);
          merged.cleanup?.();
        };
      }
      if (timeoutMs && timeoutMs > 0) {
        call.timeout = setTimeout(() => {
          pending.delete(id);
          call.onAbort?.();
          reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(id, call);
    });
  };

  const resolveMethod = (propertyKey: string) => {
    const metadata = methods?.find((method) => method.propertyKey === propertyKey);
    const methodName =
      metadata?.name ?? `${propertyKey.charAt(0).toUpperCase()}${propertyKey.slice(1)}`;
    return {
      metadata,
      method: `${serviceName}/${methodName}`,
      notification: metadata?.notification === true,
    };
  };

  const rejectPayload = (payload: JsonRpcCall[], error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const call of payload) {
      if (!('id' in call)) continue;
      const pendingCall = pending.get(String(call.id));
      if (!pendingCall) continue;
      if (pendingCall.timeout) clearTimeout(pendingCall.timeout);
      pendingCall.onAbort?.();
      pending.delete(String(call.id));
      pendingCall.reject(err);
    }
  };

  const invokeOne = async (propertyKey: string, args: unknown[]): Promise<unknown> => {
    await ensureStarted();
    const { method, notification } = resolveMethod(propertyKey);
    const { params, callOptions } = splitArgs(args);
    const id = notification ? undefined : `${Date.now().toString(36)}-${++sequence}`;
    const context: RpcInterceptorContext = {
      method,
      params,
      id,
      signal: callOptions?.signal ?? options.signal,
    };

    return composeInterceptors(interceptors, context, async () => {
      if (notification) {
        await transport.send({ jsonrpc: '2.0', method, params: context.params });
        return undefined;
      }

      const callId = id as string;
      const result = registerPending(callId, method, callOptions);
      try {
        await transport.send({
          jsonrpc: '2.0',
          id: callId,
          method,
          params: context.params,
        });
      } catch (error) {
        rejectPayload([{ jsonrpc: '2.0', id: callId, method, params: context.params }], error);
        throw error;
      }
      return result;
    });
  };

  const client = new Proxy(
    {
      async $batch<const TCalls extends readonly Promise<unknown>[]>(
        build: (rpc: RpcClient<T>) => TCalls,
      ): Promise<{ -readonly [K in keyof TCalls]: Awaited<TCalls[K]> }> {
        await ensureStarted();
        type Queued = {
          propertyKey: string;
          args: unknown[];
          promise: Promise<unknown>;
          resolve(value: unknown): void;
          reject(error: Error): void;
        };
        const queue: Queued[] = [];
        const batchProxy = new Proxy(
          {},
          {
            get(_target, propertyKey) {
              if (propertyKey === 'then') return undefined;
              if (typeof propertyKey !== 'string') return undefined;
              return (...args: unknown[]) => {
                let resolve!: (value: unknown) => void;
                let reject!: (error: Error) => void;
                const promise = new Promise<unknown>((res, rej) => {
                  resolve = res;
                  reject = rej;
                });
                queue.push({ propertyKey, args, promise, resolve, reject });
                return promise;
              };
            },
          },
        );

        const built = build(batchProxy as never);
        if (queue.length === 0) {
          return Promise.all(built) as never;
        }

        const payload: JsonRpcCall[] = [];
        let settled = 0;
        let sendStarted = false;
        const startSend = async () => {
          if (sendStarted) return;
          sendStarted = true;
          if (payload.length === 0) return;
          try {
            await transport.send(payload);
          } catch (error) {
            rejectPayload(payload, error);
            throw error;
          }
        };
        const markReady = async () => {
          settled += 1;
          if (settled === queue.length) await startSend();
        };

        await Promise.all(
          queue.map(async (item) => {
            const { method, notification } = resolveMethod(item.propertyKey);
            const { params, callOptions } = splitArgs(item.args);
            const id = notification ? undefined : `${Date.now().toString(36)}-${++sequence}`;
            const context: RpcInterceptorContext = {
              method,
              params,
              id,
              signal: callOptions?.signal ?? options.signal,
            };
            try {
              const value = await composeInterceptors(interceptors, context, async () => {
                if (notification) {
                  payload.push({ jsonrpc: '2.0', method, params: context.params });
                  await markReady();
                  return undefined;
                }
                const callId = id as string;
                const result = registerPending(callId, method, callOptions);
                payload.push({
                  jsonrpc: '2.0',
                  id: callId,
                  method,
                  params: context.params,
                });
                await markReady();
                return result;
              });
              item.resolve(value);
            } catch (error) {
              await markReady();
              item.reject(error instanceof Error ? error : new Error(String(error)));
            }
          }),
        );

        return Promise.all(built) as never;
      },
    },
    {
      get(target, propertyKey) {
        if (propertyKey === 'then') return undefined;
        if (propertyKey === '$batch') return target.$batch;
        if (typeof propertyKey !== 'string') return undefined;
        return (...args: unknown[]) => invokeOne(propertyKey, args);
      },
    },
  );

  return client as RpcClient<T>;
}
