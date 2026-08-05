/**
 * Node-primitive adapters (`node:http`+`ws`, `node:net`, `node:dgram`).
 * Prefer this entry (or the main package `server:` option) over runtime-specific APIs.
 * Runs on Node and on Bun via Node compatibility.
 */

export { createNodeListen } from './src/adapters/node-listen.ts';
export {
  // deprecated aliases
  connectBunTcpClient,
  connectTcpClient,
  createBunTcpServer,
  createTcpServer,
  type NodeTcpClientOptions,
  type NodeTcpServerOptions,
} from './src/adapters/node-tcp.ts';
export {
  connectBunUdpClient,
  connectUdpClient,
  createBunUdpSocket,
  createUdpSocket,
  type NodeUdpClientOptions,
  type NodeUdpSocketOptions,
} from './src/adapters/node-udp.ts';
export {
  connectBunWebSocketClient,
  connectWebSocketClient,
  createBunWebSocketServer,
  createWebSocketServer,
  type NodeWebSocketServerOptions,
} from './src/adapters/node-websocket.ts';
export {
  binaryFrame,
  type FrameKind,
  type SocketFrame,
  textFrame,
  toFrame,
} from './src/core/frame.ts';
