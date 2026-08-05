import { createServer, type Server as HttpServer } from 'node:http';
import { type RawData, WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { binaryFrame, type SocketFrame, textFrame } from '../core/frame.ts';
import type { CreateServerOptions, SocketConnection, SocketServer } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import { type MessageDuplex, SecureSession } from '../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from './connection-helpers.ts';

export interface NodeWebSocketServerOptions extends CreateServerOptions {
  path?: string;
  port?: number;
  hostname?: string;
}

function wsSendFrame(ws: WsWebSocket, frame: SocketFrame): void {
  if (frame.kind === 'text') {
    ws.send(frame.text ?? new TextDecoder().decode(frame.data), { binary: false });
  } else {
    ws.send(frame.data, { binary: true });
  }
}

function rawToFrame(data: RawData, isBinary: boolean): SocketFrame {
  if (!isBinary) {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : new TextDecoder().decode(new Uint8Array(data as ArrayBuffer));
    return textFrame(text);
  }
  if (Buffer.isBuffer(data)) return binaryFrame(new Uint8Array(data));
  if (data instanceof ArrayBuffer) return binaryFrame(new Uint8Array(data));
  if (Array.isArray(data)) return binaryFrame(new Uint8Array(Buffer.concat(data)));
  return binaryFrame(new Uint8Array(data as ArrayBuffer));
}

function duplexFromWs(ws: WsWebSocket): MessageDuplex {
  const handlers = new Set<(frame: SocketFrame) => void>();
  let closed = false;

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    const frame = rawToFrame(data, isBinary);
    for (const h of handlers) h(frame);
  });

  return {
    send(frame) {
      if (closed || ws.readyState !== WsWebSocket.OPEN) return;
      wsSendFrame(ws, frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      handlers.clear();
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * WebSocket server on `node:http` + `ws` (works on Node and Bun's Node compat).
 * Preserves text vs binary opcodes via `ws` `isBinary` / `{ binary }`.
 */
export function createWebSocketServer(options: NodeWebSocketServerOptions = {}): SocketServer & {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly httpServer: HttpServer;
} {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const path = options.path ?? '/';
  const hostname = options.hostname ?? '127.0.0.1';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;

  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('Not found');
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxMessageBytes,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    void (async () => {
      try {
        const duplex = duplexFromWs(ws);

        if (mode === 'plain') {
          const plain = createPlainConnection({
            protocol: 'websocket',
            mode,
            send(frame) {
              wsSendFrame(ws, frame);
            },
            close(code, reason) {
              ws.close(code, reason);
            },
          });
          duplex.onMessage((frame) => plain.dispatchMessage(frame));
          await options.onConnection?.(plain.connection);
          return;
        }

        const session = await SecureSession.connect({ role: 'provider', duplex });
        await options.onConnection?.(connectionFromSecureSession(session, 'websocket', mode));
      } catch {
        try {
          ws.close(1011, 'Handshake failed');
        } catch {
          /* ignore */
        }
      }
    })();
  });

  httpServer.listen(options.port ?? 0, hostname);

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  return {
    protocol: 'websocket',
    securityMode: mode,
    port,
    hostname,
    url: `ws://${hostname}:${port}${path === '/' ? '' : path}`,
    httpServer,
    stop() {
      wss.close();
      httpServer.close();
    },
  };
}

/**
 * WebSocket client using `ws` (Node + Bun). Preserves text/binary opcodes.
 */
export async function connectWebSocketClient(
  url: string,
  options: { security?: { mode?: SecurityMode } } = {},
): Promise<SocketConnection> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';

  const ws = new WsWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  const duplex = duplexFromWs(ws);

  if (mode === 'plain') {
    const plain = createPlainConnection({
      protocol: 'websocket',
      mode,
      send(frame) {
        wsSendFrame(ws, frame);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    });
    duplex.onMessage((frame) => plain.dispatchMessage(frame));
    return plain.connection;
  }

  const session = await SecureSession.connect({ role: 'consumer', duplex });
  return connectionFromSecureSession(session, 'websocket', mode);
}

/** @deprecated Use {@link createWebSocketServer} */
export const createBunWebSocketServer = createWebSocketServer;
/** @deprecated Use {@link connectWebSocketClient} */
export const connectBunWebSocketClient = connectWebSocketClient;
