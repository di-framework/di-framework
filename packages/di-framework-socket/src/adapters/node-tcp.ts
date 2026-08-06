import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { SocketFrame } from '../core/frame.ts';
import { encodeLengthPrefix, LengthPrefixFramer } from '../core/framing.ts';
import type { CreateServerOptions, SocketConnection, SocketServer } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import { type MessageDuplex, SecureSession } from '../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from './connection-helpers.ts';

export interface NodeTcpServerOptions extends CreateServerOptions {
  port?: number;
  hostname?: string;
}

export interface NodeTcpClientOptions {
  hostname: string;
  port: number;
  security?: { mode?: SecurityMode };
  maxMessageBytes?: number;
}

function framedDuplex(
  socket: Socket,
  framer: InstanceType<typeof LengthPrefixFramer>,
): MessageDuplex {
  const handlers = new Set<(frame: SocketFrame) => void>();
  let closed = false;

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    try {
      const frames = framer.push(new Uint8Array(chunk));
      for (const frame of frames) {
        for (const h of handlers) h(frame);
      }
    } catch {
      socket.destroy();
    }
  });

  socket.on('close', () => {
    closed = true;
    handlers.clear();
  });

  return {
    send(frame) {
      if (closed || socket.destroyed) return;
      socket.write(Buffer.from(encodeLengthPrefix(frame)));
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      socket.end();
    },
  };
}

/**
 * TCP server on `node:net` with length-prefix framing (kind-preserving).
 * Works on Node and Bun via Node compatibility.
 */
export function createTcpServer(options: NodeTcpServerOptions = {}): SocketServer & {
  readonly port: number;
  readonly hostname: string;
  readonly netServer: Server;
} {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
  const hostname = options.hostname ?? '127.0.0.1';

  const netServer = createServer((socket) => {
    const framer = new LengthPrefixFramer(maxMessageBytes);
    const duplex = framedDuplex(socket, framer);

    void (async () => {
      try {
        if (mode === 'plain') {
          const plain = createPlainConnection({
            protocol: 'tcp',
            mode,
            send(frame) {
              socket.write(Buffer.from(encodeLengthPrefix(frame)));
            },
            close() {
              socket.end();
            },
          });
          duplex.onMessage((frame) => plain.dispatchMessage(frame));
          await options.onConnection?.(plain.connection);
          return;
        }

        const session = await SecureSession.connect({ role: 'provider', duplex });
        await options.onConnection?.(connectionFromSecureSession(session, 'tcp', mode));
      } catch {
        socket.destroy();
      }
    })();
  });

  netServer.listen(options.port ?? 0, hostname);

  const address = netServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  return {
    protocol: 'tcp',
    securityMode: mode,
    port,
    hostname,
    netServer,
    stop() {
      netServer.close();
    },
  };
}

export async function connectTcpClient(options: NodeTcpClientOptions): Promise<SocketConnection> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;

  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: options.hostname, port: options.port }, () => resolve(s));
    s.once('error', reject);
  });

  const framer = new LengthPrefixFramer(maxMessageBytes);
  const duplex = framedDuplex(socket, framer);

  if (mode === 'plain') {
    const plain = createPlainConnection({
      protocol: 'tcp',
      mode,
      send(frame) {
        socket.write(Buffer.from(encodeLengthPrefix(frame)));
      },
      close() {
        socket.end();
      },
    });
    duplex.onMessage((frame) => plain.dispatchMessage(frame));
    return plain.connection;
  }

  const session = await SecureSession.connect({ role: 'consumer', duplex });
  return connectionFromSecureSession(session, 'tcp', mode);
}

/** @deprecated Use {@link createTcpServer} */
export const createBunTcpServer = createTcpServer;
/** @deprecated Use {@link connectTcpClient} */
export const connectBunTcpClient = connectTcpClient;
