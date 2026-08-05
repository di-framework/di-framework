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

export { cfMessageToFrame, sendFrame } from './src/adapters/workers/frames.ts';
export {
  createPushableDuplex,
  duplexFromWebSocket,
  type CfWebSocketLike,
  type PushableDuplex,
} from './src/adapters/workers/duplex.ts';
export {
  createWorkerWebSocketUpgrade,
  type WorkerWebSocketUpgradeOptions,
  type WebSocketPairLike,
} from './src/adapters/workers/upgrade.ts';
export {
  HibernatableSocketHub,
  type DurableObjectStateLike,
  type HibernateSecurePolicy,
  type HibernatableAttachment,
  type HibernatableHubOptions,
  type HibernatableWebSocket,
} from './src/adapters/workers/hibernatable.ts';
