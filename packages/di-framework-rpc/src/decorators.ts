import { defineMetadata, getOwnMetadata, useContainer } from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import registry from './registry.ts';
import { createRpcServer } from './server.ts';
import type {
  RpcConstructor,
  RpcFieldOptions,
  RpcMethodOptions,
  RpcNotifyOptions,
  RpcServerHandle,
  RpcServiceHost,
  RpcServiceOptions,
  RpcTransport,
} from './types.ts';

const INJECT_METADATA_KEY = 'di:inject';
const RPC_HANDLE = Symbol.for('di-framework.rpc.handle');
const RPC_OPTIONS = Symbol.for('di-framework.rpc.options');
const activeHandles = new Set<RpcServerHandle>();

interface InternalRpcHost {
  [RPC_HANDLE]?: RpcServerHandle;
  [RPC_OPTIONS]?: RpcServiceOptions;
  $startRpc?: () => Promise<RpcServerHandle>;
  $stopRpc?: () => Promise<void>;
}

function host(value: unknown): InternalRpcHost {
  return value as InternalRpcHost;
}

function ctorOf(target: object | RpcConstructor): RpcConstructor {
  return typeof target === 'function'
    ? (target as RpcConstructor)
    : (target as { constructor: RpcConstructor }).constructor;
}

function pascalCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Declare a protobuf-shaped message type. */
export function RpcMessage(options: { name?: string } = {}) {
  return <T extends RpcConstructor>(target: T): T => {
    registry.addMessage(target, options.name ?? target.name);
    return target;
  };
}

/** Declare a protobuf field. A numeric shorthand defaults the scalar type to string. */
export function RpcField(numberOrOptions: number | RpcFieldOptions) {
  return (target: object, propertyKey: string | symbol) => {
    if (typeof propertyKey !== 'string') {
      throw new Error('@RpcField requires a string property name');
    }
    const options =
      typeof numberOrOptions === 'number' ? { number: numberOrOptions } : numberOrOptions;
    if (!Number.isInteger(options.number) || options.number < 1 || options.number > 536_870_911) {
      throw new Error(`@RpcField(${options.number}) uses an invalid protobuf field number`);
    }
    registry.addField(ctorOf(target), { ...options, propertyKey });
  };
}

/** Expose a unary method over JSON-RPC and per-method gRPC. */
export function RpcMethod(options: RpcMethodOptions) {
  return (target: object, propertyKey: string | symbol) => {
    registry.addMethod(ctorOf(target), {
      propertyKey,
      name: options.name ?? pascalCase(String(propertyKey)),
      input: options.input,
      output: options.output,
      notification: false,
    });
  };
}

/** Expose a fire-and-forget JSON-RPC notification (empty unary response over gRPC). */
export function RpcNotify(options: RpcNotifyOptions) {
  return (target: object, propertyKey: string | symbol) => {
    registry.addMethod(ctorOf(target), {
      propertyKey,
      name: options.name ?? pascalCase(String(propertyKey)),
      input: options.input,
      notification: true,
    });
  };
}

function resolveTransport(options: RpcServiceOptions): RpcTransport {
  const transport =
    typeof options.transport === 'function' ? options.transport() : options.transport;
  if (!transport) {
    throw new Error(
      `@RpcService ${options.package}.${options.name ?? ''} has no transport; pass one to the decorator or startRpcServices({ transport })`,
    );
  }
  return transport;
}

function attachLifecycle(target: RpcConstructor, options: RpcServiceOptions): void {
  const prototype = host(target.prototype);
  prototype[RPC_OPTIONS] = options;
  prototype.$startRpc = async function $startRpc(this: InternalRpcHost) {
    if (this[RPC_HANDLE]?.started) return this[RPC_HANDLE];
    const handle = createRpcServer({
      transport: resolveTransport(this[RPC_OPTIONS] ?? options),
      container: (options.container ?? useContainer()) as never,
    });
    await handle.start();
    this[RPC_HANDLE] = handle;
    activeHandles.add(handle);
    return handle;
  };
  prototype.$stopRpc = async function $stopRpc(this: InternalRpcHost) {
    const handle = this[RPC_HANDLE];
    if (!handle) return;
    await handle.stop();
    activeHandles.delete(handle);
    this[RPC_HANDLE] = undefined;
  };
}

/**
 * Register a class as a DI-managed RPC service.
 * A transport supplied on the decorator auto-starts when the service is resolved.
 */
export function RpcService(options: RpcServiceOptions) {
  if (!options.package?.trim()) throw new Error('@RpcService requires a stable package name');
  return <T extends RpcConstructor>(target: T): T => {
    const name = options.name ?? target.name;
    registry.addService(target, { package: options.package, name });
    attachLifecycle(target, options);

    let registered: T = target;
    if (options.transport && options.autoStart !== false) {
      const AutoRpcService = class extends target {
        // biome-ignore lint/suspicious/noExplicitAny: decorator preserves constructor arguments
        constructor(...args: any[]) {
          super(...args);
          queueMicrotask(() => {
            void host(this)
              .$startRpc?.()
              .catch((error: unknown) => {
                console.error(`[RpcService] failed to start ${options.package}.${name}`, error);
              });
          });
        }
      } as T;
      Object.defineProperty(AutoRpcService, 'name', { value: target.name });
      registry.moveService(target, AutoRpcService, { package: options.package, name });
      attachLifecycle(AutoRpcService, options);

      const ctorInject = getOwnMetadata(INJECT_METADATA_KEY, target) || {};
      const protoInject = getOwnMetadata(INJECT_METADATA_KEY, target.prototype) || {};
      defineMetadata(INJECT_METADATA_KEY, { ...ctorInject, ...protoInject }, AutoRpcService);
      defineMetadata(INJECT_METADATA_KEY, { ...protoInject }, AutoRpcService.prototype);
      registered = AutoRpcService;
    }

    (
      ContainerDecorator({
        singleton: options.singleton,
        container: options.container as never,
      }) as (value: RpcConstructor) => RpcConstructor
    )(registered);
    return registered;
  };
}

/** Start all registered services against one transport (bootstrap/test convenience). */
export async function startRpcServices(options: {
  transport: RpcTransport;
  container?: {
    has?(target: unknown): boolean;
    register?(target: unknown, options?: { singleton?: boolean }): void;
    resolve(target: unknown): unknown;
  };
}): Promise<RpcServerHandle[]> {
  const container = options.container ?? useContainer();
  const handles: RpcServerHandle[] = [];
  // One dispatcher server handles every registered service; avoid duplicate subscribers.
  for (const service of registry.getServices()) {
    if (!container.has?.(service.target)) {
      container.register?.(service.target, { singleton: true });
    }
    container.resolve(service.target);
  }
  const handle = createRpcServer({
    transport: options.transport,
    container: container as never,
  });
  await handle.start();
  activeHandles.add(handle);
  handles.push(handle);
  return handles;
}

export async function stopRpcServices(): Promise<void> {
  const handles = [...activeHandles];
  activeHandles.clear();
  await Promise.all(handles.map((handle) => handle.stop()));
}

export type RpcServiceInstance = RpcServiceHost;
