import {
  binaryFrame,
  textFrame,
  toFrame,
  type SendInput,
  type SendOptions,
  type SocketFrame,
} from '../core/frame.ts';
import type { CreateServerOptions, SocketConnection, SocketServer } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import { SecureSession, type MessageDuplex } from '../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from './connection-helpers.ts';

export interface BunWebSocketServerOptions extends CreateServerOptions {
  path?: string;
  port?: number;
  hostname?: string;
}

type WsData = {
  duplex: MessageDuplex;
  handlers: Set<(frame: SocketFrame) => void>;
  closed: boolean;
  sendImpl: ((frame: SocketFrame) => void) | null;
  closeImpl: ((code?: number, reason?: string) => void) | null;
};

function wsSendFrame(
  ws: { send(data: string | ArrayBuffer | Uint8Array): void },
  frame: SocketFrame,
): void {
  if (frame.kind === 'text') {
    // WebSocket text opcode — must be a JS string, not UTF-8 bytes.
    ws.send(frame.text ?? new TextDecoder().decode(frame.data));
  } else {
    // WebSocket binary opcode.
    ws.send(frame.data);
  }
}

function rawToFrame(message: string | ArrayBuffer | Uint8Array): SocketFrame {
  if (typeof message === 'string') return textFrame(message);
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
  return binaryFrame(bytes);
}

function createBoundDuplex(data: WsData): MessageDuplex {
  return {
    send(frame) {
      if (data.closed) return;
      data.sendImpl?.(frame);
    },
    onMessage(handler) {
      data.handlers.add(handler);
      return () => data.handlers.delete(handler);
    },
    close(code, reason) {
      if (data.closed) return;
      data.closed = true;
      data.closeImpl?.(code, reason);
    },
  };
}

/**
 * Bun.serve WebSocket server with secure-by-default channel.
 * Preserves WebSocket text vs binary opcodes end-to-end.
 */
export function createBunWebSocketServer(options: BunWebSocketServerOptions = {}): SocketServer & {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
} {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const path = options.path ?? '/';
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;

  const server = Bun.serve<WsData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== path) {
        return new Response('Not found', { status: 404 });
      }
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const data: WsData = {
        handlers: new Set(),
        closed: false,
        sendImpl: null,
        closeImpl: null,
        duplex: null as unknown as MessageDuplex,
      };
      data.duplex = createBoundDuplex(data);

      const ok = srv.upgrade(req, { data });
      if (!ok) return new Response('Upgrade failed', { status: 400 });
      return undefined;
    },
    websocket: {
      maxPayloadLength: maxMessageBytes,
      open(ws) {
        const data = ws.data;
        data.sendImpl = (frame) => {
          if (!data.closed) wsSendFrame(ws, frame);
        };
        data.closeImpl = (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            /* already closed */
          }
        };

        void (async () => {
          try {
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
              data.handlers.add((frame) => plain.dispatchMessage(frame));
              await options.onConnection?.(plain.connection);
              return;
            }

            const session = await SecureSession.connect({
              role: 'provider',
              duplex: data.duplex,
            });
            await options.onConnection?.(connectionFromSecureSession(session, 'websocket', mode));
          } catch {
            try {
              ws.close(1011, 'Handshake failed');
            } catch {
              /* ignore */
            }
          }
        })();
      },
      message(ws, message) {
        const frame = rawToFrame(message);
        for (const h of ws.data.handlers) h(frame);
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.handlers.clear();
      },
    },
  });

  const port = server.port ?? 0;
  const hostname = server.hostname ?? '127.0.0.1';
  return {
    protocol: 'websocket',
    securityMode: mode,
    port,
    hostname,
    url: `ws://${hostname}:${port}${path === '/' ? '' : path}`,
    stop() {
      server.stop(true);
    },
  };
}

/**
 * Connect a Bun/browser WebSocket client. Preserves text vs binary opcodes.
 */
export async function connectBunWebSocketClient(
  url: string,
  options: { security?: { mode?: SecurityMode } } = {},
): Promise<SocketConnection> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const ws = new WebSocket(url);
  // Browser/Bun clients default binaryType may be blob; force arraybuffer.
  if ('binaryType' in ws) {
    (ws as WebSocket).binaryType = 'arraybuffer';
  }

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    });
  });

  const handlers = new Set<(frame: SocketFrame) => void>();
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      for (const h of handlers) h(textFrame(ev.data));
    } else if (ev.data instanceof ArrayBuffer) {
      for (const h of handlers) h(binaryFrame(new Uint8Array(ev.data)));
    } else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
      void (ev.data as Blob).arrayBuffer().then((buf) => {
        for (const h of handlers) h(binaryFrame(new Uint8Array(buf)));
      });
    }
  });

  const duplex: MessageDuplex = {
    send(frame) {
      wsSendFrame(ws, frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };

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
    handlers.add((frame) => plain.dispatchMessage(frame));
    return plain.connection;
  }

  const session = await SecureSession.connect({ role: 'consumer', duplex });
  return connectionFromSecureSession(session, 'websocket', mode);
}

// re-export for tests
export type { SendInput, SendOptions };
