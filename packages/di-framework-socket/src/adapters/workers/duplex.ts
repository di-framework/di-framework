import type { SocketFrame } from '../../core/frame.ts';
import type { MessageDuplex } from '../../security/session.ts';
import { cfMessageToFrame, sendFrame } from './frames.ts';

/** Minimal WebSocket surface used by Workers and Durable Objects. */
export interface CfWebSocketLike {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: 'message' | 'close' | 'error',
    listener: (ev: { data?: unknown }) => void,
  ): void;
  removeEventListener?(
    type: 'message' | 'close' | 'error',
    listener: (ev: { data?: unknown }) => void,
  ): void;
}

/**
 * Duplex driven by explicit {@link PushableDuplex.push} calls.
 * Use with Durable Object `webSocketMessage` (no addEventListener).
 */
export interface PushableDuplex extends MessageDuplex {
  /** Deliver an inbound frame (from `webSocketMessage`). */
  push(frame: SocketFrame): void;
  readonly closed: boolean;
}

export function createPushableDuplex(ws: CfWebSocketLike): PushableDuplex {
  const handlers = new Set<(frame: SocketFrame) => void>();
  let closed = false;

  return {
    get closed() {
      return closed;
    },
    send(frame) {
      if (closed) return;
      sendFrame(ws, frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    push(frame) {
      if (closed) return;
      for (const h of handlers) h(frame);
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      handlers.clear();
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Duplex for non-hibernating Workers: uses `addEventListener('message')`.
 * Prefer {@link createPushableDuplex} inside Durable Objects with hibernation.
 */
export function duplexFromWebSocket(ws: CfWebSocketLike): MessageDuplex & { dispose(): void } {
  const handlers = new Set<(frame: SocketFrame) => void>();
  let closed = false;

  const onMessage = (ev: { data?: unknown }) => {
    if (closed || ev.data === undefined) return;
    const data = ev.data;
    if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const frame = cfMessageToFrame(data as string | ArrayBuffer | ArrayBufferView);
      for (const h of handlers) h(frame);
    }
  };

  ws.addEventListener?.('message', onMessage);

  return {
    send(frame) {
      if (closed) return;
      sendFrame(ws, frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      handlers.clear();
      ws.removeEventListener?.('message', onMessage);
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    },
    dispose() {
      closed = true;
      handlers.clear();
      ws.removeEventListener?.('message', onMessage);
    },
  };
}
