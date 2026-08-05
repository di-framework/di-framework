/**
 * Node-primitive adapters (`node:http`+`ws`, `node:net`, `node:dgram`).
 * Prefer this entry (or the main package `server:` option) over runtime-specific APIs.
 * Runs on Node and on Bun via Node compatibility.
 */
export {
  type NodeTcpClientOptions,
  type NodeTcpServerOptions,
  connectTcpClient,
  createTcpServer,
  // deprecated aliases
  connectBunTcpClient,
  createBunTcpServer,
} from './src/adapters/node-tcp.ts';
export {
  type NodeUdpClientOptions,
  type NodeUdpSocketOptions,
  connectUdpClient,
  createUdpSocket,
  connectBunUdpClient,
  createBunUdpSocket,
} from './src/adapters/node-udp.ts';
export {
  type NodeWebSocketServerOptions,
  connectWebSocketClient,
  createWebSocketServer,
  connectBunWebSocketClient,
  createBunWebSocketServer,
} from './src/adapters/node-websocket.ts';
export { createNodeListen } from './src/adapters/node-listen.ts';
export {
  binaryFrame,
  type FrameKind,
  type SocketFrame,
  textFrame,
  toFrame,
} from './src/core/frame.ts';
