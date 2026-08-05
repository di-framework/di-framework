import { JSON_RPC_ERRORS } from './codec.ts';

/** Connect/gRPC code names (string form so core stays free of Connect imports). */
export const RPC_CONNECT_CODES = {
  CANCELED: 'canceled',
  UNKNOWN: 'unknown',
  INVALID_ARGUMENT: 'invalid_argument',
  DEADLINE_EXCEEDED: 'deadline_exceeded',
  NOT_FOUND: 'not_found',
  ALREADY_EXISTS: 'already_exists',
  PERMISSION_DENIED: 'permission_denied',
  RESOURCE_EXHAUSTED: 'resource_exhausted',
  FAILED_PRECONDITION: 'failed_precondition',
  ABORTED: 'aborted',
  OUT_OF_RANGE: 'out_of_range',
  UNIMPLEMENTED: 'unimplemented',
  INTERNAL: 'internal',
  UNAVAILABLE: 'unavailable',
  DATA_LOSS: 'data_loss',
  UNAUTHENTICATED: 'unauthenticated',
} as const;

export type RpcConnectCode = (typeof RPC_CONNECT_CODES)[keyof typeof RPC_CONNECT_CODES];

export interface RpcAppErrorOptions {
  /** JSON-RPC error code (defaults to -32000 server error). */
  code?: number;
  /** Connect/gRPC code used by the gRPC adapter (defaults to internal). */
  connectCode?: RpcConnectCode;
  data?: unknown;
}

/**
 * Throw from an `@RpcMethod` to control JSON-RPC and Connect error codes.
 * Plain `Error` still maps to JSON-RPC `-32000` / Connect `internal`.
 */
export class RpcAppError extends Error {
  override readonly name = 'RpcAppError';
  readonly code: number;
  readonly connectCode: RpcConnectCode;
  readonly data?: unknown;

  constructor(message: string, options: RpcAppErrorOptions = {}) {
    super(message);
    this.code = options.code ?? JSON_RPC_ERRORS.SERVER;
    this.connectCode = options.connectCode ?? RPC_CONNECT_CODES.INTERNAL;
    this.data = options.data;
  }
}

export function isRpcAppError(error: unknown): error is RpcAppError {
  return error instanceof RpcAppError;
}
