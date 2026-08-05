export { type MemoryPairOptions, type MemoryRpcPair, memoryPair } from './src/adapters/memory.ts';
export { createRpcClient, RpcRemoteError } from './src/client.ts';
export {
  isJsonRpcCall,
  isJsonRpcResponse,
  JSON_RPC_ERRORS,
  parseJsonRpc,
  rpcFailure,
  serializeJsonRpc,
} from './src/codec.ts';
export {
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcNotify,
  RpcService,
  startRpcServices,
  stopRpcServices,
} from './src/decorators.ts';
export { createRpcDispatcher, type RpcDispatcher } from './src/dispatcher.ts';
export {
  isRpcAppError,
  RPC_CONNECT_CODES,
  RpcAppError,
  type RpcAppErrorOptions,
  type RpcConnectCode,
} from './src/errors.ts';
export {
  default as registry,
  getRegistry,
  RpcRegistry,
  setRegistry,
} from './src/registry.ts';
export {
  decodeRpcMessage,
  encodeRpcMessage,
  hydrateRpcMessage,
  printProto,
  rpcMessageToJson,
} from './src/schema/messages.ts';
export { createRpcServer } from './src/server.ts';
export type {
  CreateRpcClientOptions,
  CreateRpcServerOptions,
  JsonRpcCall,
  JsonRpcErrorObject,
  JsonRpcFailure,
  JsonRpcNotification,
  JsonRpcPayload,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  RpcCallOptions,
  RpcClient,
  RpcConstructor,
  RpcContainer,
  RpcFieldMetadata,
  RpcFieldOptions,
  RpcId,
  RpcInterceptor,
  RpcInterceptorContext,
  RpcMessageMetadata,
  RpcMethodMetadata,
  RpcMethodOptions,
  RpcNotifyOptions,
  RpcScalarType,
  RpcServerHandle,
  RpcServerInterceptor,
  RpcServerInterceptorContext,
  RpcServiceHost,
  RpcServiceMetadata,
  RpcServiceOptions,
  RpcTransport,
  RpcTransportHandler,
  RpcTypeFactory,
  RpcUnsubscribe,
} from './src/types.ts';
