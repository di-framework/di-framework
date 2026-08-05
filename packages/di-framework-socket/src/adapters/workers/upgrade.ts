import type { SocketConnection } from '../../core/types.ts';
import type { SecurityMode } from '../../security/protocol.ts';
import { SecureSession } from '../../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from '../connection-helpers.ts';
import type { CfWebSocketLike } from './duplex.ts';
import { duplexFromWebSocket } from './duplex.ts';

/** Subset of the Workers WebSocketPair API. */
export interface WebSocketPairLike {
  0: CfWebSocketLike & { accept?(): void };
  1: CfWebSocketLike & { accept?(): void };
}

export interface WorkerWebSocketUpgradeOptions {
  security?: { mode?: SecurityMode };
  /**
   * Called once the connection is ready (after secure handshake when mode is secure).
   */
  onConnection?: (connection: SocketConnection, server: CfWebSocketLike) => void | Promise<void>;
  /**
   * Factory for `new WebSocketPair()` — inject in tests; defaults to global.
   */
  createPair?: () => WebSocketPairLike;
}

/**
 * Accept a WebSocket upgrade in a **non-hibernating** Worker (or DO without hibernation).
 *
 * Uses `server.accept()` + event listeners. For Durable Object hibernation use
 * {@link HibernatableSocketHub} instead.
 *
 * @returns Response with status 101, or a 426/400 error Response.
 */
export async function createWorkerWebSocketUpgrade(
  request: Request,
  options: WorkerWebSocketUpgradeOptions = {},
): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const createPair =
    options.createPair ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Pair = (globalThis as any).WebSocketPair;
      if (!Pair) throw new Error('WebSocketPair is not available in this runtime');
      return new Pair() as WebSocketPairLike;
    });

  const pair = createPair();
  const client = pair[0];
  const server = pair[1];

  // Non-hibernating accept: Workers put accept() on the server end; some
  // polyfills/runtimes only expose it on the client end of the pair.
  if (typeof server.accept === 'function') {
    server.accept();
  } else if (typeof client.accept === 'function') {
    client.accept();
  }

  const duplex = duplexFromWebSocket(server);

  try {
    if (mode === 'plain') {
      const plain = createPlainConnection({
        protocol: 'websocket',
        mode,
        send(frame) {
          duplex.send(frame);
        },
        close(code, reason) {
          duplex.close?.(code, reason);
        },
      });
      // Bridge duplex → plain handlers
      duplex.onMessage((frame) => plain.dispatchMessage(frame));
      await options.onConnection?.(plain.connection, server);
    } else {
      const session = await SecureSession.connect({ role: 'provider', duplex });
      const connection = connectionFromSecureSession(session, 'websocket', mode);
      await options.onConnection?.(connection, server);
    }
  } catch {
    try {
      server.close(1011, 'Handshake failed');
    } catch {
      /* ignore */
    }
    return new Response('WebSocket handshake failed', { status: 400 });
  }

  return new Response(null, {
    status: 101,
    // Workers types use webSocket; cast for portability
    // @ts-expect-error Workers ResponseInit
    webSocket: client,
  });
}
