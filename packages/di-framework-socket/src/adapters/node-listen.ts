/**
 * Built-in listen factories using Node primitives (`node:http`+`ws`, `node:net`, `node:dgram`).
 * These run on Node and on Bun via Node compatibility — not Bun.serve / Bun.listen.
 */
import type { SecurityMode } from '../security/protocol.ts';
import type { SocketGatewayDecoratorOptions, SocketListenFactory } from '../types.ts';
import { createTcpServer } from './node-tcp.ts';
import { createUdpSocket } from './node-udp.ts';
import { createWebSocketServer } from './node-websocket.ts';

export type NodeServerOptions = NonNullable<SocketGatewayDecoratorOptions['server']>;

export function createNodeListen(
  server: NodeServerOptions,
  securityMode: SecurityMode,
  maxMessageBytes: number | undefined,
): SocketListenFactory {
  return ({ onConnection }) => {
    const security = { mode: securityMode };
    switch (server.protocol) {
      case 'websocket':
        return createWebSocketServer({
          path: server.path,
          port: server.port,
          hostname: server.hostname,
          security,
          maxMessageBytes,
          onConnection,
        });
      case 'tcp':
        return createTcpServer({
          port: server.port,
          hostname: server.hostname,
          security,
          maxMessageBytes,
          onConnection,
        });
      case 'udp':
        return createUdpSocket({
          port: server.port,
          hostname: server.hostname,
          security,
          maxMessageBytes,
          onConnection,
        });
      default:
        throw new Error(`Unsupported protocol: ${String((server as { protocol: string }).protocol)}`);
    }
  };
}
