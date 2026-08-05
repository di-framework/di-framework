import type { SocketFrame } from '../core/frame.ts';
import { encodeLengthPrefix, LengthPrefixFramer } from '../core/framing.ts';
import type { CreateServerOptions, SocketConnection, SocketServer } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import { type MessageDuplex, SecureSession } from '../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from './connection-helpers.ts';

export interface BunTcpServerOptions extends CreateServerOptions {
  port?: number;
  hostname?: string;
}

export interface BunTcpClientOptions {
  hostname: string;
  port: number;
  security?: { mode?: SecurityMode };
  maxMessageBytes?: number;
}

type TcpSocketData = {
  framer: LengthPrefixFramer;
  handlers: Set<(frame: SocketFrame) => void>;
  closed: boolean;
  plain?: ReturnType<typeof createPlainConnection>;
};

function framedDuplex(
  socket: {
    write: (data: Uint8Array | string) => number;
    end: (data?: string | Uint8Array) => void;
  },
  data: TcpSocketData,
): MessageDuplex {
  return {
    send(frame) {
      if (data.closed) return;
      socket.write(encodeLengthPrefix(frame));
    },
    onMessage(handler) {
      data.handlers.add(handler);
      return () => data.handlers.delete(handler);
    },
    close() {
      if (data.closed) return;
      data.closed = true;
      try {
        socket.end();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Bun TCP server with length-prefix framing that carries frame kind
 * (text vs binary) in the wire header.
 */
export function createBunTcpServer(options: BunTcpServerOptions = {}): SocketServer & {
  readonly port: number;
  readonly hostname: string;
} {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
  const hostname = options.hostname ?? '127.0.0.1';

  const server = Bun.listen<TcpSocketData>({
    hostname,
    port: options.port ?? 0,
    socket: {
      open(socket) {
        socket.data = {
          framer: new LengthPrefixFramer(maxMessageBytes),
          handlers: new Set(),
          closed: false,
        };

        void (async () => {
          try {
            const duplex = framedDuplex(socket, socket.data);

            if (mode === 'plain') {
              const plain = createPlainConnection({
                protocol: 'tcp',
                mode,
                send(frame) {
                  socket.write(encodeLengthPrefix(frame));
                },
                close() {
                  socket.end();
                },
              });
              socket.data.plain = plain;
              socket.data.handlers.add((frame) => plain.dispatchMessage(frame));
              await options.onConnection?.(plain.connection);
              return;
            }

            const session = await SecureSession.connect({
              role: 'provider',
              duplex,
            });
            await options.onConnection?.(connectionFromSecureSession(session, 'tcp', mode));
          } catch {
            try {
              socket.end();
            } catch {
              /* ignore */
            }
          }
        })();
      },
      data(socket, chunk) {
        try {
          const frames = socket.data.framer.push(chunk);
          for (const frame of frames) {
            for (const h of socket.data.handlers) h(frame);
          }
        } catch {
          socket.end();
        }
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.handlers.clear();
        socket.data.plain?.dispatchClose({});
      },
      error(socket) {
        socket.end();
      },
    },
  });

  return {
    protocol: 'tcp',
    securityMode: mode,
    port: server.port,
    hostname: server.hostname,
    stop() {
      server.stop(true);
    },
  };
}

export async function connectBunTcpClient(options: BunTcpClientOptions): Promise<SocketConnection> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;

  const state: TcpSocketData = {
    framer: new LengthPrefixFramer(maxMessageBytes),
    handlers: new Set(),
    closed: false,
  };

  const socket = await Bun.connect<TcpSocketData>({
    hostname: options.hostname,
    port: options.port,
    socket: {
      data(sock, chunk) {
        try {
          const frames = sock.data.framer.push(chunk);
          for (const frame of frames) {
            for (const h of sock.data.handlers) h(frame);
          }
        } catch {
          sock.end();
        }
      },
      close(sock) {
        sock.data.closed = true;
        sock.data.handlers.clear();
        sock.data.plain?.dispatchClose({});
      },
      error(sock) {
        sock.end();
      },
    },
    data: state,
  });

  const duplex = framedDuplex(socket, state);
  if (socket.data) {
    socket.data.handlers = state.handlers;
    socket.data.framer = state.framer;
  }

  if (mode === 'plain') {
    const plain = createPlainConnection({
      protocol: 'tcp',
      mode,
      send(frame) {
        socket.write(encodeLengthPrefix(frame));
      },
      close() {
        socket.end();
      },
    });
    state.plain = plain;
    state.handlers.add((frame) => plain.dispatchMessage(frame));
    return plain.connection;
  }

  const session = await SecureSession.connect({ role: 'consumer', duplex });
  return connectionFromSecureSession(session, 'tcp', mode);
}
