import type { RpcTransport, RpcTransportHandler } from '../types.ts';

export interface MemoryPairOptions {
  /** Simulated one-way latency in milliseconds. */
  delayMs?: number;
}

export interface MemoryRpcPair {
  clientTransport: RpcTransport;
  serverTransport: RpcTransport;
}

/** Create two connected in-process transports for tests and local calls. */
export function memoryPair(options: MemoryPairOptions = {}): MemoryRpcPair {
  const clientHandlers = new Set<RpcTransportHandler>();
  const serverHandlers = new Set<RpcTransportHandler>();
  let stopped = false;

  const endpoint = (
    ownHandlers: Set<RpcTransportHandler>,
    peerHandlers: Set<RpcTransportHandler>,
  ): RpcTransport => ({
    async send(payload) {
      if (stopped) throw new Error('Memory RPC transport is stopped');
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      await Promise.all([...peerHandlers].map((handler) => handler(payload)));
    },
    subscribe(handler) {
      ownHandlers.add(handler);
      return () => {
        ownHandlers.delete(handler);
      };
    },
    async stop() {
      stopped = true;
      ownHandlers.clear();
    },
  });

  return {
    clientTransport: endpoint(clientHandlers, serverHandlers),
    serverTransport: endpoint(serverHandlers, clientHandlers),
  };
}
