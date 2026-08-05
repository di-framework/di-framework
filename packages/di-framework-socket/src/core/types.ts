import type { SecurityMode } from '../security/protocol.ts';
import type { FrameKind, SendInput, SendOptions, SocketFrame } from './frame.ts';

export type SocketProtocol = 'websocket' | 'tcp' | 'udp';

export type RuntimeName = 'bun' | 'node' | 'deno' | 'workers' | 'memory';

export class SocketCapabilityError extends Error {
  override readonly name = 'SocketCapabilityError';
  readonly runtime: RuntimeName;
  readonly protocol: SocketProtocol;

  // Explicit constructor (rather than parameter properties) so Bun's function
  // coverage instrumentation attributes construction to a visible, coverable frame.
  constructor(runtime: RuntimeName, protocol: SocketProtocol, message?: string) {
    super(
      message ??
        `${runtime} does not support ${protocol} in @di-framework/socket (see capability matrix)`,
    );
    this.runtime = runtime;
    this.protocol = protocol;
  }
}

export interface PeerAddress {
  host?: string;
  port?: number;
}

export interface MessageMeta {
  remote?: PeerAddress;
}

/**
 * Application message handler.
 *
 * Receives a {@link SocketFrame} — never a bare string/bytes without kind.
 * On WebSocket, `frame.kind` is the opcode (text vs binary).
 */
export type MessageHandler = (frame: SocketFrame, meta?: MessageMeta) => void | Promise<void>;

export interface SocketConnection {
  readonly id: string;
  readonly protocol: SocketProtocol;
  readonly securityMode: SecurityMode;
  /**
   * Send a frame.
   *
   * - `string` → **text** frame (unless `options.kind` overrides)
   * - `Uint8Array` / `ArrayBuffer` → **binary** frame
   * - `SocketFrame` → as-is
   */
  send(data: SendInput, options?: SendOptions): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: MessageHandler): () => void;
  onClose(handler: (info: { code?: number; reason?: string }) => void): () => void;
}

export interface SocketServer {
  readonly protocol: SocketProtocol;
  readonly securityMode: SecurityMode;
  stop(): void | Promise<void>;
}

export interface CreateServerOptions {
  security?: { mode?: SecurityMode };
  onConnection?: (connection: SocketConnection) => void | Promise<void>;
  /** Max application payload size in bytes (default 1 MiB). */
  maxMessageBytes?: number;
}

export type { FrameKind, SendInput, SendOptions, SocketFrame };
