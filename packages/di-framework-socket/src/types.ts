import type { SocketConnection, SocketProtocol, SocketServer } from './core/types.ts';
import type { SecurityMode } from './security/protocol.ts';

export type { SocketConnection, SocketProtocol, SocketServer, SecurityMode };

/** How the gateway obtains a listening server. */
export type SocketListenFactory = (hooks: {
  onConnection: (connection: SocketConnection) => void | Promise<void>;
  securityMode: SecurityMode;
}) => SocketServer | Promise<SocketServer>;

export interface SocketGatewayDecoratorOptions {
  /**
   * Built-in Bun listener. Prefer this for the common path; use `listen` for
   * custom runtimes.
   */
  bun?: {
    protocol: SocketProtocol;
    path?: string;
    port?: number;
    hostname?: string;
  };
  /**
   * Custom listen factory (any runtime). Receives connection hooks from the
   * decorated handlers.
   */
  listen?: SocketListenFactory;
  security?: { mode?: SecurityMode };
  /** Max application payload (passed through to adapters where supported). */
  maxMessageBytes?: number;
  singleton?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors core container option
  container?: any;
  /**
   * Start listening when the class is resolved (default `true`), same idea as
   * `@EventBridge({ autoStart })`.
   */
  autoStart?: boolean;
}

export interface OnMessageDecoratorOptions {
  /**
   * If set, only handle JSON messages with `{ type: this }`.
   * Only applies to **text** frames (JSON is text).
   */
  type?: string;
  /**
   * Filter by frame kind. Default `'any'`.
   * On WebSocket this is the opcode (text vs binary).
   */
  frame?: import('./core/frame.ts').FrameKind | 'any';
}

export interface SocketGatewayHandle {
  start(): Promise<SocketServer>;
  stop(): Promise<void>;
  readonly started: boolean;
  readonly server: SocketServer | undefined;
}
