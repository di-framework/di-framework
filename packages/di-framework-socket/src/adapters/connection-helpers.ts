import {
  toFrame,
  type SendInput,
  type SendOptions,
  type SocketFrame,
} from '../core/frame.ts';
import type { MessageHandler, SocketConnection, SocketProtocol } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import type { SecureSession } from '../security/session.ts';

/** Build a SocketConnection facade over a confirmed SecureSession. */
export function connectionFromSecureSession(
  session: SecureSession,
  protocol: SocketProtocol,
  mode: SecurityMode,
): SocketConnection {
  const id = session.sessionId ?? crypto.randomUUID();
  return {
    id,
    protocol,
    securityMode: mode,
    async send(payload: SendInput, options?: SendOptions) {
      await session.send(payload, options);
    },
    close() {
      session.close();
    },
    onMessage(handler: MessageHandler) {
      return session.onData((frame) => {
        void handler(frame);
      });
    },
    onClose() {
      return () => {};
    },
  };
}

/** Plain SocketConnection with explicit frame fan-out. */
export function createPlainConnection(options: {
  protocol: SocketProtocol;
  mode: SecurityMode;
  send: (frame: SocketFrame) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  id?: string;
}): {
  connection: SocketConnection;
  dispatchMessage: (frame: SocketFrame) => void;
  dispatchClose: (info: { code?: number; reason?: string }) => void;
} {
  const messageHandlers = new Set<MessageHandler>();
  const closeHandlers = new Set<(info: { code?: number; reason?: string }) => void>();
  const id = options.id ?? crypto.randomUUID();

  return {
    connection: {
      id,
      protocol: options.protocol,
      securityMode: options.mode,
      send(payload: SendInput, sendOpts?: SendOptions) {
        return options.send(toFrame(payload, sendOpts));
      },
      close: options.close,
      onMessage(handler) {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      onClose(handler) {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    },
    dispatchMessage(frame) {
      for (const h of messageHandlers) void h(frame);
    },
    dispatchClose(info) {
      for (const h of closeHandlers) h(info);
    },
  };
}
