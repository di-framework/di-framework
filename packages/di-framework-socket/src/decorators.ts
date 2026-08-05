import { defineMetadata, getOwnMetadata, useContainer } from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import type { SocketConnection, SocketServer } from './core/types.ts';
import registry from './registry.ts';
import type { SecurityMode } from './security/protocol.ts';
import type {
  OnMessageDecoratorOptions,
  SocketGatewayDecoratorOptions,
  SocketGatewayHandle,
  SocketListenFactory,
} from './types.ts';

const INJECT_METADATA_KEY = 'di:inject';

// biome-ignore lint/suspicious/noExplicitAny: decorator targets are heterogeneous
type Ctor = new (...args: any[]) => any;

const GATEWAY_HANDLE = Symbol.for('di-framework.socket.gateway-handle');
const GATEWAY_OPTIONS = Symbol.for('di-framework.socket.gateway-options');
const PATCHED_KEY = '__diSocketGatewayPatched';

interface GatewayHost {
  [GATEWAY_HANDLE]?: SocketGatewayHandle;
  [GATEWAY_OPTIONS]?: SocketGatewayDecoratorOptions;
  [PATCHED_KEY]?: boolean;
  $startGateway?: () => Promise<SocketServer>;
  $stopGateway?: () => Promise<void>;
}

function asHost(value: unknown): GatewayHost {
  return value as GatewayHost;
}

function methodDecorator(
  kind: 'connect' | 'message' | 'close' | 'error',
  extra?: { type?: string; frame?: import('./core/frame.ts').FrameKind | 'any' },
) {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: Ctor }).constructor;
    registry.addHandler(ctor, {
      kind,
      method: propertyKey,
      type: extra?.type,
      frame: extra?.frame,
    });
  };
}

/** Handle a new connection (after secure handshake when mode is `secure`). */
export function OnConnect() {
  return methodDecorator('connect');
}

/**
 * Handle an application message.
 *
 * Receives `(conn, frame: SocketFrame)`. Frame kind is preserved from the wire
 * (WebSocket text vs binary opcodes).
 *
 * @example
 * @OnMessage()
 * onAny(conn, frame: SocketFrame) {}
 *
 * @OnMessage({ frame: 'binary' })
 * onBin(conn, frame: SocketFrame) {}
 *
 * @OnMessage({ frame: 'text', type: 'chat' })
 * onChat(conn, frame: SocketFrame, json: { type: 'chat'; text: string }) {}
 */
export function OnMessage(options: OnMessageDecoratorOptions = {}) {
  return methodDecorator('message', { type: options.type, frame: options.frame ?? 'any' });
}

/** Connection closed. */
export function OnClose() {
  return methodDecorator('close');
}

/** Uncaught error while dispatching a handler. */
export function OnError() {
  return methodDecorator('error');
}

function resolveListen(
  options: SocketGatewayDecoratorOptions,
  securityMode: SecurityMode,
): SocketListenFactory {
  if (options.listen) return options.listen;

  // `server` is the preferred name; `bun` is a deprecated alias (Node primitives either way).
  const server = options.server ?? options.bun;
  if (server) {
    // Lazy import so Workers / edge consumers of decorators don't load node:net/ws
    // until a process actually starts a gateway.
    return async (hooks) => {
      const { createNodeListen } = await import('./adapters/node-listen.ts');
      return createNodeListen(server, securityMode, options.maxMessageBytes)(hooks);
    };
  }

  throw new Error(
    '@SocketGateway requires either `server: { protocol, … }` or a custom `listen` factory',
  );
}

function wireConnection(
  instance: object,
  connection: SocketConnection,
  entryHandlers: import('./registry.ts').SocketHandlerMeta[],
): void {
  const call = async (kind: string, ...args: unknown[]) => {
    for (const h of entryHandlers) {
      if (h.kind !== kind) continue;
      const method = (instance as Record<string | symbol, unknown>)[h.method];
      if (typeof method !== 'function') continue;
      try {
        if (kind === 'message') {
          const frame = args[1] as import('./core/frame.ts').SocketFrame;
          if (h.frame && h.frame !== 'any' && frame.kind !== h.frame) continue;

          if (h.type) {
            // JSON message types only make sense on text frames.
            if (frame.kind !== 'text' || frame.text === undefined) continue;
            let json: unknown;
            try {
              json = JSON.parse(frame.text);
            } catch {
              continue;
            }
            if (!json || typeof json !== 'object' || (json as { type?: unknown }).type !== h.type) {
              continue;
            }
            await (method as Function).call(instance, args[0], frame, json);
          } else {
            await (method as Function).call(instance, args[0], frame);
          }
        } else {
          await (method as Function).call(instance, ...args);
        }
      } catch (error) {
        const errorHandlers = entryHandlers.filter((x) => x.kind === 'error');
        if (errorHandlers.length === 0) throw error;
        for (const eh of errorHandlers) {
          const m = (instance as Record<string | symbol, unknown>)[eh.method];
          if (typeof m === 'function') await (m as Function).call(instance, connection, error);
        }
      }
    }
  };

  void call('connect', connection);

  connection.onMessage((frame) => {
    void call('message', connection, frame);
  });

  connection.onClose((info) => {
    void call('close', connection, info);
  });
}

function createHandle(
  instance: object,
  ctor: Ctor,
  options: SocketGatewayDecoratorOptions,
): SocketGatewayHandle {
  let server: SocketServer | undefined;
  let started = false;

  return {
    get started() {
      return started;
    },
    get server() {
      return server;
    },
    async start() {
      if (started && server) return server;
      const securityMode: SecurityMode = options.security?.mode ?? 'secure';
      const listen = resolveListen(options, securityMode);
      const entry = registry.get(ctor);
      const handlers = entry?.handlers ?? [];

      server = await listen({
        securityMode,
        onConnection: (connection) => {
          wireConnection(instance, connection, handlers);
        },
      });
      started = true;
      return server;
    },
    async stop() {
      if (server) await server.stop();
      server = undefined;
      started = false;
    },
  };
}

function attachGatewayMethods(ctor: Ctor, options: SocketGatewayDecoratorOptions): void {
  const proto = asHost(ctor.prototype);
  if (proto[PATCHED_KEY]) return;
  proto[PATCHED_KEY] = true;

  proto.$startGateway = async function $startGateway(this: GatewayHost) {
    let handle = this[GATEWAY_HANDLE];
    if (!handle) {
      handle = createHandle(this as object, ctor, this[GATEWAY_OPTIONS] ?? options);
      this[GATEWAY_HANDLE] = handle;
    }
    return handle.start();
  };

  proto.$stopGateway = async function $stopGateway(this: GatewayHost) {
    await this[GATEWAY_HANDLE]?.stop();
  };
}

/**
 * Marks a class as a socket gateway and registers it with the DI container.
 *
 * Collect `@OnConnect` / `@OnMessage` / `@OnClose` / `@OnError` handlers, then
 * listen via Node primitives (`server: { protocol }`) or a custom `listen` factory.
 *
 * @example
 * ```ts
 * @SocketGateway({
 *   server: { protocol: 'websocket', path: '/ws', port: 3000 },
 *   security: { mode: 'secure' }, // default
 * })
 * class ChatGateway {
 *   @Component(LoggerService)
 *   logger!: LoggerService;
 *
 *   @OnConnect()
 *   open(conn: SocketConnection) {
 *     this.logger.log(`connected ${conn.id}`);
 *   }
 *
 *   @OnMessage({ frame: 'text', type: 'chat' })
 *   onChat(conn: SocketConnection, _frame: SocketFrame, msg: { text: string }) {
 *     void conn.send(JSON.stringify({ type: 'chat', text: msg.text }));
 *   }
 *
 *   @OnClose()
 *   close(conn: SocketConnection) {
 *     this.logger.log(`closed ${conn.id}`);
 *   }
 * }
 *
 * useContainer().resolve(ChatGateway); // autoStart listens
 * // or: await startSocketGateways();
 * ```
 */
export function SocketGateway(options: SocketGatewayDecoratorOptions = {}) {
  return <T extends Ctor>(target: T): T => {
    registry.addTarget(target);
    attachGatewayMethods(target, options);
    asHost(target.prototype)[GATEWAY_OPTIONS] = options;

    const autoStart = options.autoStart !== false;

    const register = (ctor: Ctor) => {
      // Container decorator accepts concrete constructors; gateway classes are concrete at runtime.
      (
        ContainerDecorator({
          singleton: options.singleton,
          container: options.container as never,
        }) as (c: Ctor) => Ctor
      )(ctor);
    };

    if (!autoStart) {
      register(target);
      return target;
    }

    // Subclass so construction can auto-listen without hooking Container internals
    // (same pattern as @EventBridge).
    const GatewayClass = class extends target {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors decorated class arity
      constructor(...args: any[]) {
        super(...args);
        const host = asHost(this);
        host[GATEWAY_OPTIONS] = options;
        // Handler metadata lives on the original class; methods are inherited.
        host[GATEWAY_HANDLE] = createHandle(this, target, options);
        const autoStartGateway = () => {
          void host.$startGateway?.().catch((err: unknown) => {
            console.error(`[SocketGateway] failed to start ${target.name}`, err);
          });
        };
        queueMicrotask(autoStartGateway);
      }
    } as T;

    Object.defineProperty(GatewayClass, 'name', { value: target.name });
    asHost(GatewayClass.prototype)[GATEWAY_OPTIONS] = options;
    attachGatewayMethods(GatewayClass as unknown as Ctor, options);

    // Copy @Component inject metadata onto the subclass — the container only
    // reads metadata on the resolved constructor (same gap @EventBridge has
    // unless metadata is copied).
    const ctorInject = getOwnMetadata(INJECT_METADATA_KEY, target) || {};
    const protoInject = getOwnMetadata(INJECT_METADATA_KEY, target.prototype) || {};
    defineMetadata(INJECT_METADATA_KEY, { ...ctorInject, ...protoInject }, GatewayClass);
    defineMetadata(INJECT_METADATA_KEY, { ...protoInject }, GatewayClass.prototype);

    // Point registry at the class the container will resolve (copy handlers).
    const prior = registry.get(target);
    registry.addTarget(GatewayClass as unknown as Ctor);
    if (prior) {
      for (const h of prior.handlers) {
        registry.addHandler(GatewayClass as unknown as Ctor, h);
      }
    }

    register(GatewayClass as unknown as Ctor);
    return GatewayClass;
  };
}

/**
 * Start every registered `@SocketGateway` (or only those listed).
 * Prefer autoStart, or call `$startGateway()` on a resolved instance.
 */
export async function startSocketGateways(targets?: Ctor[]): Promise<SocketServer[]> {
  const container = useContainer();
  const list = (targets ?? registry.all().map((e) => e.target)) as Ctor[];
  const servers: SocketServer[] = [];
  for (const target of list) {
    const instance = container.resolve(target) as GatewayHost;
    if (typeof instance.$startGateway === 'function') {
      servers.push(await instance.$startGateway());
    }
  }
  return servers;
}

export async function stopSocketGateways(targets?: Ctor[]): Promise<void> {
  const container = useContainer();
  const list = (targets ?? registry.all().map((e) => e.target)) as Ctor[];
  for (const target of list) {
    // Skip targets the container does not know about (avoid constructing them just to stop).
    if (typeof container.has === 'function' && !container.has(target)) continue;
    try {
      const instance = container.resolve(target) as GatewayHost;
      await instance.$stopGateway?.();
    } catch {
      /* not constructed */
    }
  }
}
