/**
 * Durable Object hibernatable WebSocket hub.
 *
 * Policies for secure sessions after the DO wakes:
 * - `plain` — no ECDH; frames only
 * - `secure` + `rehydrate` — persist {@link SecureSessionSnapshot} in attachment
 * - `secure` + `rehandshake` — drop crypto state; close with 4001 so clients reconnect
 *
 * Never call `ws.accept()` when using this API — only `state.acceptWebSocket(ws)`.
 */

import {
  connectionFromSecureSession,
  createPlainConnection,
} from '../connection-helpers.ts';
import type { SocketConnection } from '../../core/types.ts';
import type { SecurityMode } from '../../security/protocol.ts';
import {
  SecureSession,
  type SecureSessionSnapshot,
} from '../../security/session.ts';
import {
  createPushableDuplex,
  type CfWebSocketLike,
  type PushableDuplex,
} from './duplex.ts';
import { cfMessageToFrame } from './frames.ts';

/** Attachment blob stored via `serializeAttachment`. */
export interface HibernatableAttachment {
  v: 1;
  security: SecurityMode;
  /** Present when policy is secure + rehydrate and handshake completed. */
  snapshot?: SecureSessionSnapshot;
  /** App-defined metadata (principal id, room, …). */
  meta?: Record<string, unknown>;
}

export type HibernateSecurePolicy = 'rehydrate' | 'rehandshake';

export interface HibernatableHubOptions {
  /**
   * `plain` — no secure channel.
   * `secure` — ECDH session; choose {@link onHibernate}.
   */
  security?: { mode?: SecurityMode };
  /**
   * What to do with secure sessions when the DO wakes.
   * - `rehydrate` (default for secure): restore AEAD from attachment
   * - `rehandshake`: close with 4001; client should open a new socket
   */
  onHibernate?: HibernateSecurePolicy;
  /**
   * Called when a connection is ready (after handshake / rehydrate / plain accept).
   */
  onConnection?: (
    connection: SocketConnection,
    ws: HibernatableWebSocket,
  ) => void | Promise<void>;
  /**
   * Invoked when attachment is about to be written (add app meta).
   */
  onSerializeAttachment?: (
    current: HibernatableAttachment,
    ws: HibernatableWebSocket,
  ) => HibernatableAttachment | void;
  /**
   * Close code used for rehandshake policy (default 4001).
   */
  rehandshakeCloseCode?: number;
  rehandshakeCloseReason?: string;
}

/** CF WebSocket with hibernation attachment helpers. */
export interface HibernatableWebSocket extends CfWebSocketLike {
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface DurableObjectStateLike {
  acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): HibernatableWebSocket[];
}

interface LiveSocket {
  ws: HibernatableWebSocket;
  duplex: PushableDuplex;
  connection: SocketConnection;
  session?: SecureSession;
  plain?: ReturnType<typeof createPlainConnection>;
}

const REHANDSHAKE_CODE = 4001;
const REHANDSHAKE_REASON = 'secure session requires rehandshake after hibernation';

/**
 * Manages hibernatable WebSockets on a Durable Object.
 *
 * Wire DO methods:
 * ```ts
 * async fetch(req) { return this.hub.handleUpgrade(req); }
 * async webSocketMessage(ws, msg) { await this.hub.webSocketMessage(ws, msg); }
 * async webSocketClose(ws, code, reason) { this.hub.webSocketClose(ws); }
 * // constructor: this.hub.restoreFromHibernation();
 * ```
 */
export class HibernatableSocketHub {
  private readonly live = new Map<HibernatableWebSocket, LiveSocket>();
  private readonly mode: SecurityMode;
  private readonly onHibernate: HibernateSecurePolicy;
  private readonly rehandshakeCloseCode: number;
  private readonly rehandshakeCloseReason: string;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly options: HibernatableHubOptions = {},
  ) {
    this.mode = options.security?.mode ?? 'secure';
    this.onHibernate = options.onHibernate ?? 'rehydrate';
    this.rehandshakeCloseCode = options.rehandshakeCloseCode ?? REHANDSHAKE_CODE;
    this.rehandshakeCloseReason = options.rehandshakeCloseReason ?? REHANDSHAKE_REASON;
  }

  /**
   * Call from the DO constructor (or first alarm) after wake to rebuild sessions
   * from attachments for sockets still connected at the edge.
   */
  async restoreFromHibernation(): Promise<void> {
    const sockets = this.state.getWebSockets?.() ?? [];
    for (const ws of sockets) {
      if (this.live.has(ws)) continue;
      await this.restoreOne(ws);
    }
  }

  /**
   * Accept an upgrade request: `WebSocketPair` + `acceptWebSocket` + optional handshake.
   */
  async handleUpgrade(
    request: Request,
    createPair?: () => { 0: HibernatableWebSocket; 1: HibernatableWebSocket },
  ): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = createPair
      ? createPair()
      : (() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Pair = (globalThis as any).WebSocketPair;
          if (!Pair) throw new Error('WebSocketPair is not available');
          return new Pair() as { 0: HibernatableWebSocket; 1: HibernatableWebSocket };
        })();

    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    this.writeAttachment(server, {
      v: 1,
      security: this.mode,
    });

    try {
      await this.attachNew(server);
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
      // @ts-expect-error Workers ResponseInit.webSocket
      webSocket: client,
    });
  }

  /** DO `webSocketMessage` handler. */
  async webSocketMessage(
    ws: HibernatableWebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    let entry = this.live.get(ws);
    if (!entry) {
      // Woke mid-connection without restore — try restore or rehandshake
      await this.restoreOne(ws);
      entry = this.live.get(ws);
      if (!entry) return;
    }

    const frame = cfMessageToFrame(message);
    entry.duplex.push(frame);

    // Keep attachment counters fresh for rehydrate policy
    if (this.mode === 'secure' && this.onHibernate === 'rehydrate' && entry.session) {
      try {
        this.persistSession(ws, entry.session);
      } catch {
        /* session may not be open yet */
      }
    }
  }

  /** DO `webSocketClose` handler. */
  webSocketClose(ws: HibernatableWebSocket): void {
    const entry = this.live.get(ws);
    if (!entry) return;
    entry.session?.close();
    entry.duplex.close?.();
    this.live.delete(ws);
  }

  /** DO `webSocketError` handler. */
  webSocketError(ws: HibernatableWebSocket): void {
    this.webSocketClose(ws);
  }

  getConnection(ws: HibernatableWebSocket): SocketConnection | undefined {
    return this.live.get(ws)?.connection;
  }

  private async attachNew(ws: HibernatableWebSocket): Promise<void> {
    const duplex = createPushableDuplex(ws);

    if (this.mode === 'plain') {
      const plain = createPlainConnection({
        protocol: 'websocket',
        mode: 'plain',
        send(frame) {
          duplex.send(frame);
        },
        close(code, reason) {
          duplex.close?.(code, reason);
        },
      });
      duplex.onMessage((frame) => plain.dispatchMessage(frame));
      this.live.set(ws, { ws, duplex, connection: plain.connection, plain });
      await this.options.onConnection?.(plain.connection, ws);
      return;
    }

    // Register duplex immediately so handshake replies from the client can
    // arrive via webSocketMessage → push while SecureSession.connect is awaiting.
    const pending: LiveSocket = {
      ws,
      duplex,
      connection: {
        id: 'pending',
        protocol: 'websocket',
        securityMode: 'secure',
        send() {
          throw new Error('Secure handshake not finished');
        },
        close(code, reason) {
          duplex.close?.(code, reason);
        },
        onMessage() {
          return () => {};
        },
        onClose() {
          return () => {};
        },
      },
    };
    this.live.set(ws, pending);

    const session = await SecureSession.connect({ role: 'provider', duplex });
    const connection = connectionFromSecureSession(session, 'websocket', 'secure');
    pending.session = session;
    pending.connection = connection;
    this.persistSession(ws, session);
    await this.options.onConnection?.(connection, ws);
  }

  private async restoreOne(ws: HibernatableWebSocket): Promise<void> {
    const att = this.readAttachment(ws);

    if (this.mode === 'plain') {
      const duplex = createPushableDuplex(ws);
      const plain = createPlainConnection({
        protocol: 'websocket',
        mode: 'plain',
        send(frame) {
          duplex.send(frame);
        },
        close(code, reason) {
          duplex.close?.(code, reason);
        },
      });
      duplex.onMessage((frame) => plain.dispatchMessage(frame));
      this.live.set(ws, { ws, duplex, connection: plain.connection, plain });
      await this.options.onConnection?.(plain.connection, ws);
      return;
    }

    // secure
    if (this.onHibernate === 'rehandshake') {
      try {
        ws.close(this.rehandshakeCloseCode, this.rehandshakeCloseReason);
      } catch {
        /* ignore */
      }
      return;
    }

    // rehydrate
    if (!att?.snapshot) {
      try {
        ws.close(this.rehandshakeCloseCode, 'missing secure session snapshot');
      } catch {
        /* ignore */
      }
      return;
    }

    const duplex = createPushableDuplex(ws);
    try {
      const session = await SecureSession.rehydrate({ duplex, snapshot: att.snapshot });
      const connection = connectionFromSecureSession(session, 'websocket', 'secure');
      this.live.set(ws, { ws, duplex, connection, session });
      await this.options.onConnection?.(connection, ws);
    } catch {
      try {
        ws.close(1011, 'session rehydrate failed');
      } catch {
        /* ignore */
      }
    }
  }

  private persistSession(ws: HibernatableWebSocket, session: SecureSession): void {
    const snapshot = session.exportSnapshot();
    const base: HibernatableAttachment = {
      v: 1,
      security: 'secure',
      snapshot,
      meta: this.readAttachment(ws)?.meta,
    };
    this.writeAttachment(ws, base);
  }

  private readAttachment(ws: HibernatableWebSocket): HibernatableAttachment | null {
    try {
      const raw = ws.deserializeAttachment?.() as HibernatableAttachment | null | undefined;
      if (raw && raw.v === 1) return raw;
      return null;
    } catch {
      return null;
    }
  }

  private writeAttachment(ws: HibernatableWebSocket, value: HibernatableAttachment): void {
    let next = value;
    if (this.options.onSerializeAttachment) {
      const patched = this.options.onSerializeAttachment(value, ws);
      if (patched) next = patched;
    }
    try {
      ws.serializeAttachment?.(next);
    } catch {
      /* attachment may exceed size limits — caller should use DO storage */
    }
  }
}
