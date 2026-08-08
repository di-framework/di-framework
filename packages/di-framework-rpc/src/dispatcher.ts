import { useContainer } from '@di-framework/core/container';
import { isJsonRpcCall, isJsonRpcStreamFrame, JSON_RPC_ERRORS, rpcFailure } from './codec.ts';
import { isAsyncIterable, isStream, unwrapStream } from './decorators.ts';
import { isRpcAppError } from './errors.ts';
import registry, { type RpcRegistry } from './registry.ts';
import { hydrateRpcMessage, rpcMessageToJson } from './schema/messages.ts';
import type {
  JsonRpcCall,
  JsonRpcResponse,
  JsonRpcStreamComplete,
  JsonRpcStreamError,
  JsonRpcStreamFrame,
  JsonRpcStreamNextSuccess,
  JsonRpcSuccess,
  RpcContainer,
  RpcServerInterceptor,
} from './types.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAsyncGeneratorFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  return (
    fn.constructor?.name === 'AsyncGeneratorFunction' ||
    Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'
  );
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
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver.resolve({ value, done: false });
      }
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    if (this.isDone || this.errorState) return;
    this.isDone = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver.resolve({ value: undefined as never, done: true });
      }
    }
  }

  error(err: unknown): void {
    if (this.isDone || this.errorState) return;
    this.errorState = err;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver.reject(err);
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    try {
      while (true) {
        if (this.queue.length > 0) {
          const item = this.queue.shift();
          if (item !== undefined) {
            yield item;
          }
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
    } finally {
      this.end();
    }
  }
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

export type SendFrameFn = (frame: JsonRpcResponse) => Promise<void>;

export interface RpcDispatcher {
  dispatch(
    payload: unknown,
    sendFrame?: SendFrameFn,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
}

export function createRpcDispatcher(
  options: {
    container?: RpcContainer;
    registry?: RpcRegistry;
    interceptors?: readonly RpcServerInterceptor[];
  } = {},
): RpcDispatcher {
  const container = options.container ?? (useContainer() as RpcContainer);
  const source = options.registry ?? registry;
  const interceptors = options.interceptors ?? [];

  const activeSessions = new Map<
    string | number,
    { stream: PushStream<unknown>; signalController: AbortController }
  >();

  const dispatchStreamFrame = (frame: JsonRpcStreamFrame): undefined => {
    if (frame.id === null || frame.id === undefined) return undefined;
    const session = activeSessions.get(frame.id);
    if (!session) return undefined;
    if (frame.stream === 'next') {
      session.stream.push(frame.params ?? frame.result);
    } else if (frame.stream === 'complete') {
      session.stream.end();
      activeSessions.delete(frame.id);
    } else if (frame.stream === 'error') {
      session.stream.error(frame.error);
      session.signalController.abort();
      activeSessions.delete(frame.id);
    }
    return undefined;
  };

  const dispatchOne = async (
    call: JsonRpcCall,
    sendFrame?: SendFrameFn,
  ): Promise<JsonRpcResponse | undefined> => {
    const id = 'id' in call ? call.id : undefined;
    const match = source.findMethod(call.method);
    if (!match) {
      return id === undefined
        ? undefined
        : rpcFailure(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found');
    }

    try {
      const instance = container.resolve(match.service.target) as Record<string | symbol, unknown>;
      const handler = instance[match.method.propertyKey];
      if (typeof handler !== 'function') {
        throw new Error(`${call.method} is not callable`);
      }

      const inputMsg = unwrapStream(match.method.input());
      const outputMsg = match.method.output ? unwrapStream(match.method.output()) : undefined;

      const isClientStream =
        match.method.clientStreaming === true || isStream(match.method.input());
      const isServerStream =
        match.method.serverStreaming === true ||
        (match.method.output ? isStream(match.method.output()) : false) ||
        isAsyncGeneratorFunction(handler);

      if (isClientStream) {
        const pushStream = new PushStream<unknown>();
        const signalController = new AbortController();
        if (id !== undefined) {
          activeSessions.set(id, { stream: pushStream, signalController });
        }

        async function* hydratedInputStream() {
          for await (const rawParam of pushStream) {
            if (signalController.signal.aborted) break;
            yield hydrateRpcMessage(inputMsg, rawParam, source);
          }
        }

        const runClientStream = async () => {
          try {
            const rawResult = await composeServerInterceptors(
              interceptors,
              {
                method: call.method,
                params: call.params,
                id,
                service: match.service,
                methodMeta: match.method,
              },
              () =>
                (handler as (input: unknown) => unknown).call(
                  instance,
                  hydratedInputStream(),
                ) as Promise<unknown>,
            );

            if (isServerStream && isAsyncIterable(rawResult)) {
              for await (const item of rawResult as AsyncIterable<unknown>) {
                if (signalController.signal.aborted) break;
                const finalItem = await composeServerInterceptors(
                  interceptors,
                  {
                    method: call.method,
                    params: item,
                    id,
                    service: match.service,
                    methodMeta: match.method,
                  },
                  async () => item,
                );
                const nextFrame: JsonRpcStreamNextSuccess = {
                  jsonrpc: '2.0',
                  id: id ?? null,
                  stream: 'next',
                  result: outputMsg ? rpcMessageToJson(outputMsg, finalItem, source) : finalItem,
                };
                if (sendFrame) await sendFrame(nextFrame);
              }
              const completeFrame: JsonRpcStreamComplete = {
                jsonrpc: '2.0',
                id: id ?? null,
                stream: 'complete',
              };
              if (sendFrame) await sendFrame(completeFrame);
            } else {
              const resJson = outputMsg
                ? rpcMessageToJson(outputMsg, rawResult, source)
                : rawResult;
              const response: JsonRpcSuccess = { jsonrpc: '2.0', id: id ?? null, result: resJson };
              if (sendFrame) await sendFrame(response);
            }
          } catch (error) {
            const errObj = isRpcAppError(error)
              ? {
                  code: error.code,
                  message: error.message,
                  ...(error.data === undefined ? {} : { data: error.data }),
                }
              : { code: JSON_RPC_ERRORS.SERVER, message: errorMessage(error) };
            const errorFrame: JsonRpcStreamError = {
              jsonrpc: '2.0',
              id: id ?? null,
              stream: 'error',
              error: errObj,
            };
            if (sendFrame) await sendFrame(errorFrame);
          } finally {
            if (id !== undefined) activeSessions.delete(id);
          }
        };

        if (sendFrame) {
          await runClientStream();
          return undefined;
        }
        await runClientStream();
        return undefined;
      }

      if (isServerStream) {
        const signalController = new AbortController();
        const dummyPushStream = new PushStream<unknown>();
        if (id !== undefined) {
          activeSessions.set(id, { stream: dummyPushStream, signalController });
        }

        const runServerStream = async () => {
          try {
            const input = hydrateRpcMessage(inputMsg, call.params ?? {}, source);
            const rawResult = await composeServerInterceptors(
              interceptors,
              {
                method: call.method,
                params: call.params,
                id,
                service: match.service,
                methodMeta: match.method,
              },
              () =>
                (handler as (input: unknown) => unknown).call(instance, input) as Promise<unknown>,
            );

            if (isAsyncIterable(rawResult)) {
              for await (const item of rawResult as AsyncIterable<unknown>) {
                if (signalController.signal.aborted) break;
                const finalItem = await composeServerInterceptors(
                  interceptors,
                  {
                    method: call.method,
                    params: item,
                    id,
                    service: match.service,
                    methodMeta: match.method,
                  },
                  async () => item,
                );
                const nextFrame: JsonRpcStreamNextSuccess = {
                  jsonrpc: '2.0',
                  id: id ?? null,
                  stream: 'next',
                  result: outputMsg ? rpcMessageToJson(outputMsg, finalItem, source) : finalItem,
                };
                if (sendFrame) await sendFrame(nextFrame);
              }
              const completeFrame: JsonRpcStreamComplete = {
                jsonrpc: '2.0',
                id: id ?? null,
                stream: 'complete',
              };
              if (sendFrame) await sendFrame(completeFrame);
            }
          } catch (error) {
            const errObj = isRpcAppError(error)
              ? {
                  code: error.code,
                  message: error.message,
                  ...(error.data === undefined ? {} : { data: error.data }),
                }
              : { code: JSON_RPC_ERRORS.SERVER, message: errorMessage(error) };
            const errorFrame: JsonRpcStreamError = {
              jsonrpc: '2.0',
              id: id ?? null,
              stream: 'error',
              error: errObj,
            };
            if (sendFrame) await sendFrame(errorFrame);
          } finally {
            if (id !== undefined) activeSessions.delete(id);
          }
        };

        if (sendFrame) {
          await runServerStream();
          return undefined;
        }
        await runServerStream();
        return undefined;
      }

      // Unary call
      const input = hydrateRpcMessage(inputMsg, call.params ?? {}, source);
      const result = await composeServerInterceptors(
        interceptors,
        {
          method: call.method,
          params: call.params,
          id,
          service: match.service,
          methodMeta: match.method,
        },
        () => (handler as (input: unknown) => unknown).call(instance, input) as Promise<unknown>,
      );

      if (id === undefined || match.method.notification) return undefined;
      const resFrame: JsonRpcSuccess = {
        jsonrpc: '2.0',
        id,
        result: outputMsg ? rpcMessageToJson(outputMsg, result, source) : null,
      };
      if (sendFrame) {
        await sendFrame(resFrame);
        return undefined;
      }
      return resFrame;
    } catch (error) {
      if (id === undefined) return undefined;
      let failure: JsonRpcResponse;
      if (isRpcAppError(error)) {
        failure = rpcFailure(id, error.code, error.message, error.data);
      } else {
        const invalid =
          error instanceof TypeError ||
          (error instanceof Error &&
            (error.message.includes('input must') || error.message.includes('must be an array')));
        failure = rpcFailure(
          id,
          invalid ? JSON_RPC_ERRORS.INVALID_PARAMS : JSON_RPC_ERRORS.SERVER,
          invalid ? 'Invalid params' : errorMessage(error),
        );
      }
      if (sendFrame) {
        await sendFrame(failure);
        return undefined;
      }
      return failure;
    }
  };

  return {
    async dispatch(payload, sendFrame) {
      if (Array.isArray(payload)) {
        if (
          payload.length === 0 ||
          !payload.every((item) => isJsonRpcCall(item) || isJsonRpcStreamFrame(item))
        ) {
          return [rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request')];
        }
        const responses: JsonRpcResponse[] = [];
        for (const item of payload) {
          if (isJsonRpcStreamFrame(item)) {
            dispatchStreamFrame(item);
          } else {
            const res = await dispatchOne(item, sendFrame);
            if (res !== undefined) responses.push(res);
          }
        }
        return responses.length > 0 ? responses : undefined;
      }
      if (isJsonRpcStreamFrame(payload)) {
        return dispatchStreamFrame(payload);
      }
      if (!isJsonRpcCall(payload)) {
        return rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
      }
      return dispatchOne(payload, sendFrame);
    },
  };
}
