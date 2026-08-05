import type { SocketConnection } from '@di-framework/socket';
import { parseJsonRpc } from '../codec.ts';
import type { RpcTransport, RpcTransportHandler } from '../types.ts';

/** Adapt an established @di-framework/socket connection to RPC frames. */
export function socketTransport(connection: SocketConnection): RpcTransport {
  const handlers = new Set<RpcTransportHandler>();
  const unsubscribe = connection.onMessage(async (frame) => {
    if (frame.kind !== 'text' || frame.text === undefined) return;
    const payload = parseJsonRpc(frame.text);
    await Promise.all([...handlers].map((handler) => handler(payload)));
  });

  return {
    async send(payload) {
      await connection.send(JSON.stringify(payload));
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      unsubscribe();
      handlers.clear();
    },
  };
}
