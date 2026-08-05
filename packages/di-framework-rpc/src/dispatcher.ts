import { useContainer } from '@di-framework/core/container';
import { isJsonRpcCall, JSON_RPC_ERRORS, rpcFailure } from './codec.ts';
import { isRpcAppError } from './errors.ts';
import registry, { type RpcRegistry } from './registry.ts';
import { hydrateRpcMessage, rpcMessageToJson } from './schema/messages.ts';
import type { JsonRpcCall, JsonRpcResponse, RpcContainer, RpcServerInterceptor } from './types.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export interface RpcDispatcher {
  dispatch(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
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

  const dispatchOne = async (call: JsonRpcCall): Promise<JsonRpcResponse | undefined> => {
    const id = 'id' in call ? call.id : undefined;
    const match = source.findMethod(call.method);
    if (!match) {
      return id === undefined
        ? undefined
        : rpcFailure(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found');
    }

    try {
      const input = hydrateRpcMessage(match.method.input(), call.params ?? {}, source);
      const instance = container.resolve(match.service.target) as Record<string | symbol, unknown>;
      const handler = instance[match.method.propertyKey];
      if (typeof handler !== 'function') {
        throw new Error(`${call.method} is not callable`);
      }

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
      return {
        jsonrpc: '2.0',
        id,
        result: match.method.output
          ? rpcMessageToJson(match.method.output(), result, source)
          : null,
      };
    } catch (error) {
      if (id === undefined) return undefined;
      if (isRpcAppError(error)) {
        return rpcFailure(id, error.code, error.message, error.data);
      }
      const invalid =
        error instanceof TypeError ||
        (error instanceof Error &&
          (error.message.includes('input must') || error.message.includes('must be an array')));
      return rpcFailure(
        id,
        invalid ? JSON_RPC_ERRORS.INVALID_PARAMS : JSON_RPC_ERRORS.SERVER,
        invalid ? 'Invalid params' : errorMessage(error),
      );
    }
  };

  return {
    async dispatch(payload) {
      if (Array.isArray(payload)) {
        if (payload.length === 0 || !payload.every(isJsonRpcCall)) {
          return [rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request')];
        }
        const responses = (await Promise.all(payload.map(dispatchOne))).filter(
          (response): response is JsonRpcResponse => response !== undefined,
        );
        return responses.length > 0 ? responses : undefined;
      }
      if (!isJsonRpcCall(payload)) {
        return rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
      }
      return dispatchOne(payload);
    },
  };
}
