/**
 * Cloudflare Workers & Durable Objects WebSocket adapters.
 *
 * @example Non-hibernating Worker
 * ```ts
 * import { createWorkerWebSocketUpgrade } from '@di-framework/socket/workers';
 * export default {
 *   fetch(req) {
 *     return createWorkerWebSocketUpgrade(req, {
 *       onConnection(conn) {
 *         conn.onMessage((frame) => void conn.send(frame));
 *       },
 *     });
 *   },
 * };
 * ```
 *
 * @example Hibernatable Durable Object
 * ```ts
 * import { HibernatableSocketHub } from '@di-framework/socket/workers';
 * export class Room {
 *   hub: HibernatableSocketHub;
 *   constructor(ctx: DurableObjectState) {
 *     this.hub = new HibernatableSocketHub(ctx, {
 *       security: { mode: 'secure' },
 *       onHibernate: 'rehydrate', // or 'rehandshake'
 *       onConnection(conn) { … },
 *     });
 *     void this.hub.restoreFromHibernation();
 *   }
 *   fetch(req: Request) { return this.hub.handleUpgrade(req); }
 *   webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
 *     return this.hub.webSocketMessage(ws, msg);
 *   }
 *   webSocketClose(ws: WebSocket) { this.hub.webSocketClose(ws); }
 * }
 * ```
 */

export {
  type CfWebSocketLike,
  createPushableDuplex,
  duplexFromWebSocket,
  type PushableDuplex,
} from './src/adapters/workers/duplex.ts';
export { cfMessageToFrame, sendFrame } from './src/adapters/workers/frames.ts';
export {
  type DurableObjectStateLike,
  type HibernatableAttachment,
  type HibernatableHubOptions,
  HibernatableSocketHub,
  type HibernatableWebSocket,
  type HibernateSecurePolicy,
} from './src/adapters/workers/hibernatable.ts';
export {
  createWorkerWebSocketUpgrade,
  type WebSocketPairLike,
  type WorkerWebSocketUpgradeOptions,
} from './src/adapters/workers/upgrade.ts';
