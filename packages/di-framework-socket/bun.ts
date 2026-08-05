/**
 * @deprecated Use `@di-framework/socket/node` — adapters are Node primitives
 * (`node:net`, `node:dgram`, `node:http`+`ws`) and work on Bun via Node compat.
 * This entry re-exports the same APIs for existing imports.
 */
export {
  binaryFrame,
  connectBunTcpClient,
  connectBunUdpClient,
  connectBunWebSocketClient,
  connectTcpClient,
  connectUdpClient,
  connectWebSocketClient,
  createBunTcpServer,
  createBunUdpSocket,
  createBunWebSocketServer,
  createNodeListen,
  createTcpServer,
  createUdpSocket,
  createWebSocketServer,
  type FrameKind,
  type NodeTcpClientOptions as BunTcpClientOptions,
  type NodeTcpServerOptions as BunTcpServerOptions,
  type NodeUdpClientOptions as BunUdpClientOptions,
  type NodeUdpSocketOptions as BunUdpSocketOptions,
  type NodeWebSocketServerOptions as BunWebSocketServerOptions,
  type SocketFrame,
  textFrame,
  toFrame,
} from './node.ts';
