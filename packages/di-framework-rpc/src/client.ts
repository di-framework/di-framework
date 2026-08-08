import { isAsyncGeneratorFunction, isStream, unwrapStream } from './decorators.ts';
import registry from './registry.ts';
import { hydrateRpcMessage, rpcMessageToJson } from './schema/messages.ts';
import type {
  CreateRpcClientOptions,
  JsonRpcCall,
  JsonRpcFailure,
  JsonRpcResponse,
  JsonRpcStreamFrame,
  RpcCallOptions,
  RpcClient,
  RpcConstructor,
  RpcInterceptor,
  RpcInterceptorContext,
  RpcTransport,
} from './types.ts';

function detectServerStreamingMethods(target: RpcConstructor): void {
  const service = registry.getService(target);
  if (!service) return;
  const proto = target.prototype as Record<string | symbol, unknown>;
  for (const method of service.methods) {
    if (method.serverStreaming === undefined || method.serverStreaming === false) {
      const fn = proto[method.propertyKey];
      if (isAsyncGeneratorFunction(fn)) {
        method.serverStreaming = true;
      }
    }
  }
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Settled by resolve/reject; kept so rejectPayload can attach a no-op catch. */
  promise?: Promise<unknown>;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export class PushStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  private isDone = false;
  private errorState: unknown = undefined;

  push(value: T): void {
    if (this.isDone || this.errorState) return;
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    if (this.isDone || this.errorState) return;
    this.isDone = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value: undefined as never, done: true });
    }
  }

  error(err: unknown): void {
    if (this.isDone || this.errorState) return;
    this.errorState = err;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.reject(err);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.isDone) {
        return;
      } else if (this.errorState) {
        throw this.errorState;
      } else {
        const nextResult = await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
        if (nextResult.done) return;
        yield nextResult.value;
      }
    }
  }
}

interface PendingStream {
  stream: PushStream<unknown>;
  outputMsg?: RpcConstructor;
  mergedCleanup?: () => void;
  onAbort?: () => void;
  chain?: Promise<void>;
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

function isAsyncIterableInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string | symbol, unknown>)[Symbol.asyncIterator] === 'function';
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
  if (hasServiceClass) detectServerStreamingMethods(serviceOrTransport);
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
  const pendingStreams = new Map<string, PendingStream>();
  let sequence = 0;
  let started: Promise<void> | undefined;

  const ensureStarted = () => {
    started ??= Promise.resolve(transport.start?.()).then(() => undefined);
    return started;
  };

  const settle = async (id: string, response: JsonRpcResponse) => {
    if ('stream' in response) {
      const streamEntry = pendingStreams.get(id);
      if (streamEntry) {
        const frame = response as JsonRpcStreamFrame;
        streamEntry.chain = (streamEntry.chain ?? Promise.resolve()).then(async () => {
          if (frame.stream === 'next') {
            try {
              const rawItem = frame.result ?? frame.params;
              const hydrated = streamEntry.outputMsg
                ? hydrateRpcMessage(streamEntry.outputMsg, rawItem, registry)
                : rawItem;
              const finalItem = await composeInterceptors(
                interceptors,
                { method: serviceName!, params: hydrated, id },
                async () => hydrated,
              );
              streamEntry.stream.push(finalItem);
            } catch (err) {
              streamEntry.stream.error(err);
            }
          } else if (frame.stream === 'complete') {
            streamEntry.onAbort?.();
            streamEntry.mergedCleanup?.();
            pendingStreams.delete(id);
            streamEntry.stream.end();
          } else if (frame.stream === 'error') {
            streamEntry.onAbort?.();
            streamEntry.mergedCleanup?.();
            pendingStreams.delete(id);
            streamEntry.stream.error(
              new RpcRemoteError(frame.error.code, frame.error.message, frame.error.data),
            );
          }
        });
      }
      return;
    }

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
      void settle(String((candidate as JsonRpcResponse).id), candidate as JsonRpcResponse);
    }
  });

  const registerPending = (
    id: string,
    method: string,
    callOptions: RpcCallOptions | undefined,
  ): Promise<unknown> => {
    const timeoutMs = callOptions?.timeoutMs ?? options.timeoutMs;
    const merged = mergeSignals(options.signal, callOptions?.signal);
    let call!: PendingCall;
    const promise = new Promise<unknown>((resolve, reject) => {
      call = { resolve, reject };
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
    call.promise = promise;
    return promise;
  };

  const resolveMethod = (propertyKey: string) => {
    const metadata = methods?.find((method) => method.propertyKey === propertyKey);
    const methodName =
      metadata?.name ?? `${propertyKey.charAt(0).toUpperCase()}${propertyKey.slice(1)}`;
    const isClientStream =
      metadata?.clientStreaming === true || (metadata?.input ? isStream(metadata.input()) : false);
    const isServerStream =
      metadata?.serverStreaming === true ||
      (metadata?.output ? isStream(metadata.output()) : false);
    return {
      metadata,
      method: `${serviceName}/${methodName}`,
      notification: metadata?.notification === true,
      isClientStream,
      isServerStream,
    };
  };

  const rejectPayload = (payload: JsonRpcCall[], error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const call of payload) {
      if (!('id' in call)) continue;
      const pendingCall = pending.get(String(call.id));
      if (pendingCall) {
        if (pendingCall.timeout) clearTimeout(pendingCall.timeout);
        pendingCall.onAbort?.();
        pending.delete(String(call.id));
        void pendingCall.promise?.catch(() => {});
        pendingCall.reject(err);
      }
      const streamEntry = pendingStreams.get(String(call.id));
      if (streamEntry) {
        streamEntry.onAbort?.();
        streamEntry.mergedCleanup?.();
        pendingStreams.delete(String(call.id));
        streamEntry.stream.error(err);
      }
    }
  };

  const invokeOne = (propertyKey: string, args: unknown[]): unknown => {
    const { metadata, method, notification, isClientStream, isServerStream } =
      resolveMethod(propertyKey);
    const { params, callOptions } = splitArgs(args);
    const id = notification ? undefined : `${Date.now().toString(36)}-${++sequence}`;
    const context: RpcInterceptorContext = {
      method,
      params,
      id,
      signal: callOptions?.signal ?? options.signal,
    };

    const inputMsg = metadata?.input ? unwrapStream(metadata.input()) : undefined;
    const outputMsg = metadata?.output ? unwrapStream(metadata.output()) : undefined;

    const actualClientStream = isClientStream || isAsyncIterableInput(params);

    if (isServerStream) {
      const callId = id as string;
      const pushStream = new PushStream<unknown>();
      const merged = mergeSignals(options.signal, callOptions?.signal);

      const startStream = async (): Promise<PushStream<unknown>> => {
        await ensureStarted();
        return composeInterceptors(interceptors, context, async () => {
          const pendingStream: PendingStream = {
            stream: pushStream,
            outputMsg,
            mergedCleanup: merged.cleanup,
          };

          if (merged.signal) {
            if (merged.signal.aborted) {
              merged.cleanup?.();
              throw merged.signal.reason instanceof Error
                ? merged.signal.reason
                : new Error(`RPC ${method} aborted`);
            }
            const onAbort = () => {
              pendingStreams.delete(callId);
              merged.cleanup?.();
              pushStream.error(
                merged.signal?.reason instanceof Error
                  ? merged.signal.reason
                  : new Error(`RPC ${method} aborted`),
              );
              void transport
                .send({
                  jsonrpc: '2.0',
                  id: callId,
                  stream: 'error',
                  error: { code: -32000, message: 'RPC stream aborted' },
                })
                .catch(() => {});
            };
            merged.signal.addEventListener('abort', onAbort, { once: true });
            pendingStream.onAbort = () => {
              merged.signal?.removeEventListener('abort', onAbort);
              merged.cleanup?.();
            };
          }

          pendingStreams.set(callId, pendingStream);

          if (actualClientStream) {
            // Bi-directional streaming
            await transport.send({ jsonrpc: '2.0', id: callId, method });
            (async () => {
              try {
                for await (const item of params as AsyncIterable<unknown>) {
                  if (merged.signal?.aborted) break;
                  const itemToSend = await composeInterceptors(
                    interceptors,
                    { method, params: item, id: callId },
                    async () => item,
                  );
                  const jsonItem = inputMsg
                    ? rpcMessageToJson(inputMsg, itemToSend, registry)
                    : itemToSend;
                  await transport.send({
                    jsonrpc: '2.0',
                    id: callId,
                    stream: 'next',
                    params: jsonItem,
                  });
                }
                await transport.send({ jsonrpc: '2.0', id: callId, stream: 'complete' });
              } catch (err) {
                await transport
                  .send({
                    jsonrpc: '2.0',
                    id: callId,
                    stream: 'error',
                    error: {
                      code: -32000,
                      message: err instanceof Error ? err.message : String(err),
                    },
                  })
                  .catch(() => {});
              }
            })();
          } else {
            // Server-streaming only
            await transport.send({
              jsonrpc: '2.0',
              id: callId,
              method,
              params: context.params,
            });
          }

          return pushStream;
        }) as Promise<PushStream<unknown>>;
      };

      const streamPromise = startStream().catch((err) => {
        pushStream.error(err);
        return pushStream;
      });

      const asyncIterable: AsyncIterable<unknown> = {
        async *[Symbol.asyncIterator]() {
          const activeStream = await streamPromise;
          for await (const item of activeStream) {
            yield item;
          }
        },
      };

      return asyncIterable;
    }

    if (actualClientStream) {
      const callId = id as string;
      return ensureStarted().then(() =>
        composeInterceptors(interceptors, context, async () => {
          const resultPromise = registerPending(callId, method, callOptions);
          await transport.send({ jsonrpc: '2.0', id: callId, method });

          (async () => {
            try {
              for await (const item of params as AsyncIterable<unknown>) {
                const itemToSend = await composeInterceptors(
                  interceptors,
                  { method, params: item, id: callId },
                  async () => item,
                );
                const jsonItem = inputMsg
                  ? rpcMessageToJson(inputMsg, itemToSend, registry)
                  : itemToSend;
                await transport.send({
                  jsonrpc: '2.0',
                  id: callId,
                  stream: 'next',
                  params: jsonItem,
                });
              }
              await transport.send({ jsonrpc: '2.0', id: callId, stream: 'complete' });
            } catch (err) {
              rejectPayload([{ jsonrpc: '2.0', id: callId, method }], err);
            }
          })();

          const rawResult = await resultPromise;
          return outputMsg ? hydrateRpcMessage(outputMsg, rawResult, registry) : rawResult;
        }),
      );
    }

    // Standard Unary call
    return ensureStarted().then(() =>
      composeInterceptors(interceptors, context, async () => {
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
          return result;
        }
        const rawResult = await result;
        return rawResult;
      }),
    );
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
            throw error instanceof Error ? error : new Error(String(error));
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
