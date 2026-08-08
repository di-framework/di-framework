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
  RpcStreamWrapper,
  RpcTransport,
  RpcTypeFactory,
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

export function isStream(value: unknown): value is RpcStreamWrapper {
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>).__rpcStream === true;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    Symbol.asyncIterator in (value as object)
  );
}

function isConstructor(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    return Boolean(fn.prototype && fn.prototype.constructor === fn);
  } catch {
    return false;
  }
}

export function unwrapStream<T>(value: unknown): RpcConstructor<T> {
  if (isStream(value)) {
    return unwrapStream(value.factory());
  }
  if (typeof value === 'function') {
    if (isConstructor(value)) {
      return value as RpcConstructor<T>;
    }
    const res = (value as RpcTypeFactory<T>)();
    return unwrapStream(res);
  }
  return value as RpcConstructor<T>;
}

/** Wrap a message type factory to denote a streaming input or output. */
export function Stream<T>(
  factory: RpcTypeFactory<T> | RpcConstructor<T> | RpcStreamWrapper<T>,
): RpcStreamWrapper<T> {
  if (isStream(factory)) return factory as RpcStreamWrapper<T>;
  const fn: RpcTypeFactory<T> =
    typeof factory === 'function' &&
    !(factory.prototype && factory.prototype.constructor === factory)
      ? (factory as RpcTypeFactory<T>)
      : () => factory as RpcConstructor<T>;
  return {
    __rpcStream: true,
    factory: fn,
  };
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

/** Expose a unary or streaming method over JSON-RPC and per-method gRPC. */
export function RpcMethod(options: RpcMethodOptions) {
  return (target: object, propertyKey: string | symbol) => {
    const inputVal = typeof options.input === 'function' ? options.input() : options.input;
    const outputVal = options.output
      ? typeof options.output === 'function'
        ? options.output()
        : options.output
      : undefined;

    const clientStreaming =
      options.clientStreaming ?? (isStream(inputVal) || isStream(options.input));
    const serverStreaming =
      options.serverStreaming ??
      (outputVal ? isStream(outputVal) || isStream(options.output) : false);

    const inputFactory = isStream(inputVal) ? inputVal.factory : (options.input as RpcTypeFactory);

    const outputFactory = options.output
      ? isStream(outputVal)
        ? outputVal.factory
        : (options.output as RpcTypeFactory)
      : undefined;

    registry.addMethod(ctorOf(target), {
      propertyKey,
      name: options.name ?? pascalCase(String(propertyKey)),
      input: inputFactory,
      output: outputFactory,
      notification: false,
      clientStreaming,
      serverStreaming,
    });
  };
}

/** Decorator to mark a method as streaming, with optional Stream wrappers or flags. */
export function RpcStream(options?: RpcMethodOptions) {
  return (target: object, propertyKey: string | symbol) => {
    if (options && (options.input || options.output)) {
      RpcMethod(options)(target, propertyKey);
    } else {
      const existing = registry
        .getService(ctorOf(target))
        ?.methods.find((m) => m.propertyKey === propertyKey);
      if (existing) {
        if (options?.clientStreaming !== undefined) {
          existing.clientStreaming = options.clientStreaming;
        }
        if (options?.serverStreaming !== undefined) {
          existing.serverStreaming = options.serverStreaming;
        }
      }
    }
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

export function isAsyncGeneratorFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  const name = fn.constructor?.name;
  const str = Object.prototype.toString.call(fn);
  const isAsyncGen =
    name === 'AsyncGeneratorFunction' ||
    str === '[object AsyncGeneratorFunction]' ||
    (typeof Symbol !== 'undefined' && Symbol.asyncIterator in fn);
  return isAsyncGen;
}

function detectServerStreamingMethods(target: RpcConstructor): void {
  const service = registry.getService(target);
  if (!service) return;
  const proto = target.prototype as Record<string | symbol, unknown>;
  for (const method of service.methods) {
    if (method.serverStreaming === undefined || method.serverStreaming === false) {
      const fn = proto[method.propertyKey];
      if (isAsyncGeneratorFunction(fn)) {
        method.serverStreaming = true;
      }
    }
  }
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
    detectServerStreamingMethods(target);
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
      detectServerStreamingMethods(AutoRpcService);
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
