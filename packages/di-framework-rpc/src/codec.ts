import type {
  JsonRpcCall,
  JsonRpcFailure,
  JsonRpcPayload,
  JsonRpcResponse,
  JsonRpcStreamFrame,
  RpcId,
} from './types.ts';

export const JSON_RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  SERVER: -32000,
} as const;

export function rpcFailure(
  id: RpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function isJsonRpcCall(value: unknown): value is JsonRpcCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === '2.0' &&
    typeof record.method === 'string' &&
    (!('id' in record) || typeof record.id === 'string' || typeof record.id === 'number')
  );
}

export function isJsonRpcStreamFrame(value: unknown): value is JsonRpcStreamFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === '2.0' &&
    (record.stream === 'next' || record.stream === 'complete' || record.stream === 'error') &&
    (record.id === null || typeof record.id === 'string' || typeof record.id === 'number')
  );
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === '2.0' &&
    ('result' in record || 'error' in record || 'stream' in record) &&
    (record.id === null || typeof record.id === 'string' || typeof record.id === 'number')
  );
}

export function parseJsonRpc(input: string | unknown): JsonRpcPayload | JsonRpcFailure {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return rpcFailure(null, JSON_RPC_ERRORS.PARSE, 'Parse error');
    }
  }
  if (Array.isArray(value)) {
    if (
      value.length === 0 ||
      !value.every(
        (item) => isJsonRpcCall(item) || isJsonRpcResponse(item) || isJsonRpcStreamFrame(item),
      )
    ) {
      return rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
    }
    return value as JsonRpcPayload;
  }
  if (!isJsonRpcCall(value) && !isJsonRpcResponse(value) && !isJsonRpcStreamFrame(value)) {
    return rpcFailure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
  }
  return value;
}

export function serializeJsonRpc(payload: JsonRpcPayload): string {
  return JSON.stringify(payload);
}
