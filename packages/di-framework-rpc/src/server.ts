import { createRpcDispatcher } from './dispatcher.ts';
import type { CreateRpcServerOptions, RpcServerHandle, RpcUnsubscribe } from './types.ts';

export function createRpcServer(options: CreateRpcServerOptions): RpcServerHandle {
  const dispatcher = createRpcDispatcher({
    container: options.container,
    interceptors: options.interceptors,
  });
  let started = false;
  let unsubscribe: RpcUnsubscribe | undefined;

  return {
    get started() {
      return started;
    },

    async start() {
      if (started) return;
      await options.transport.start?.();
      unsubscribe = options.transport.subscribe(async (payload) => {
        try {
          const response = await dispatcher.dispatch(payload, async (frame) => {
            await options.transport.send(frame);
          });
          if (response !== undefined) await options.transport.send(response);
        } catch (error) {
          options.onError?.(error);
        }
      });
      started = true;
    },

    async stop() {
      if (!started) return;
      await unsubscribe?.();
      unsubscribe = undefined;
      await options.transport.stop?.();
      started = false;
    },
  };
}
