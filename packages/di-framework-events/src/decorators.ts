import { useContainer } from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import { createEventBridge } from './bridge.ts';
import registry, { type EventBridgeTarget } from './registry.ts';
import type {
  EventBridgeContainer,
  EventBridgeDecoratorOptions,
  EventBridgeHandle,
  EventTransport,
  InboundDecoratorOptions,
  InboundMiddleware,
  OutboundDecoratorOptions,
} from './types.ts';

const BRIDGE_HANDLE = Symbol.for('di-framework.events.bridge-handle');
const SOURCE_KEY = '__diEventsSource';
const PATCHED_KEY = '__diEventsBridgePatched';

type Ctor = EventBridgeTarget;

interface BridgeHost {
  transport?: EventTransport;
  $startBridge?: () => Promise<EventBridgeHandle>;
  $stopBridge?: () => Promise<void>;
  [BRIDGE_HANDLE]?: EventBridgeHandle;
  [PATCHED_KEY]?: boolean;
  [SOURCE_KEY]?: Ctor;
}

function asHost(value: unknown): BridgeHost {
  return value as BridgeHost;
}

function asContainer(value: unknown): EventBridgeContainer {
  return (value ?? useContainer()) as EventBridgeContainer;
}

function resolveTransport(
  instance: BridgeHost,
  options: EventBridgeDecoratorOptions,
  container: EventBridgeContainer,
): EventTransport {
  if (typeof options.transport === 'function') return options.transport();
  if (options.transport) return options.transport;

  if (instance.transport && typeof instance.transport.publish === 'function') {
    return instance.transport;
  }

  const token = options.transportToken ?? 'EventTransport';
  return container.resolve?.(token) as EventTransport;
}

function attachBridgeMethods(ctor: Ctor, options: EventBridgeDecoratorOptions): void {
  const proto = asHost(ctor.prototype);
  if (proto[PATCHED_KEY]) return;
  proto[PATCHED_KEY] = true;

  proto.$startBridge = async function $startBridge(this: BridgeHost): Promise<EventBridgeHandle> {
    const existing = this[BRIDGE_HANDLE];
    if (existing?.started) return existing;

    const container = asContainer(options.container);
    const transport = resolveTransport(this, options, container);
    const entry = registry.get(ctor);
    const handle = createEventBridge({
      container,
      transport,
      routes: {
        outbound: entry?.outbound ?? [],
        inbound: entry?.inbound ?? [],
      },
      codec: options.codec,
      onError: options.onError,
      middleware: options.middleware,
    });
    await handle.start();
    this[BRIDGE_HANDLE] = handle;
    return handle;
  };

  proto.$stopBridge = async function $stopBridge(this: BridgeHost): Promise<void> {
    const handle = this[BRIDGE_HANDLE];
    if (handle) await handle.stop();
    this[BRIDGE_HANDLE] = undefined;
  };
}

function registerWithContainer(target: Ctor, options: EventBridgeDecoratorOptions): void {
  ContainerDecorator({
    singleton: options.singleton,
    container: options.container as never,
  })(target);
}

/**
 * Marks a class as an event bridge definition and registers it with the DI container.
 * Collect `@Outbound` / `@Inbound` routes from the class. Call `$startBridge()` on the
 * resolved instance, or `startEventBridges()`, to connect the transport.
 *
 * When `autoStart` is true (default), the bridge starts on the next microtask after
 * the instance is constructed (via a subclass wrapper).
 */
export function EventBridge(options: EventBridgeDecoratorOptions = {}) {
  return <T extends Ctor>(target: T): T => {
    const entry = registry.addTarget(target);
    entry.options = options;
    attachBridgeMethods(target, options);

    const autoStart = options.autoStart !== false;

    if (!autoStart) {
      registerWithContainer(target, options);
      return target;
    }

    // Subclass so construction can kick off the bridge without hooking Container internals.
    const BridgeClass = class extends target {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors decorated class arity
      constructor(...args: any[]) {
        super(...args);
        queueMicrotask(() => {
          void asHost(this)
            .$startBridge?.()
            .catch((err: unknown) => {
              console.error(`[EventBridge] failed to start ${target.name}`, err);
            });
        });
      }
    } as T;

    Object.defineProperty(BridgeClass, 'name', { value: target.name });
    attachBridgeMethods(BridgeClass, options);

    // Point registry entries at the class the container will resolve.
    const prior = registry.get(target);
    const slot = registry.addTarget(BridgeClass);
    slot.options = options;
    if (prior) {
      slot.outbound.push(...prior.outbound);
      slot.inbound.push(...prior.inbound);
    }

    // Keep original key too so startEventBridges(registry) can find either.
    asHost(BridgeClass)[SOURCE_KEY] = target;

    registerWithContainer(BridgeClass, options);

    return BridgeClass;
  };
}

function ctorFromDecoratorTarget(target: object | Ctor): Ctor {
  if (typeof target === 'function') return target as Ctor;
  return (target as { constructor: Ctor }).constructor;
}

/**
 * Declares an outbound route: container `event` → broker `topic`.
 * May decorate a property or method (body unused; options carry map/key/filter).
 */
export function Outbound(event: string, options: OutboundDecoratorOptions) {
  return (target: object, _propertyKey: string | symbol) => {
    registry.addOutbound(ctorFromDecoratorTarget(target), {
      event,
      topic: options.topic,
      map: options.map,
      key: options.key,
      filter: options.filter,
      headers: options.headers,
    });
  };
}

/**
 * Declares an inbound route: broker `topic` → container `event`.
 */
export function Inbound(options: InboundDecoratorOptions) {
  return (target: object, _propertyKey: string | symbol) => {
    registry.addInbound(ctorFromDecoratorTarget(target), {
      topic: options.topic,
      event: options.event,
      map: options.map,
      filter: options.filter,
      validate: options.validate,
      middleware: options.middleware,
    });
  };
}

/**
 * Resolve every `@EventBridge` class and start its transport bridge.
 * Prefer this in bootstrap when `autoStart` was disabled or after `container.clear()`.
 */
export async function startEventBridges(
  options: {
    container?: EventBridgeContainer;
    transport?: EventTransport | (() => EventTransport);
    middleware?: InboundMiddleware | InboundMiddleware[];
  } = {},
): Promise<EventBridgeHandle[]> {
  const container = options.container ?? useContainer();
  const handles: EventBridgeHandle[] = [];
  const seen = new Set<Ctor>();

  for (const entry of registry.getAll()) {
    const source = asHost(entry.target)[SOURCE_KEY];
    if (source && seen.has(source)) continue;
    if (seen.has(entry.target)) continue;
    seen.add(entry.target);
    if (source) seen.add(source);

    // Prefer the container-registered subclass when present.
    let ctor = entry.target;
    if (!container.has?.(ctor) && source && container.has?.(source)) {
      ctor = source;
    } else if (source) {
      for (const other of registry.getAll()) {
        if (asHost(other.target)[SOURCE_KEY] === source || other.target === entry.target) {
          if (container.has?.(other.target)) {
            ctor = other.target;
            break;
          }
        }
      }
    }

    const resolvable = container.has?.(ctor) ? ctor : entry.target;
    if (!container.has?.(resolvable)) {
      container.register?.(resolvable, { singleton: true });
    }

    const instance = asHost(container.resolve?.(resolvable));

    if (typeof instance.$startBridge === 'function') {
      if (options.transport) {
        const transport =
          typeof options.transport === 'function' ? options.transport() : options.transport;
        const handle = createEventBridge({
          container,
          transport,
          routes: { outbound: entry.outbound, inbound: entry.inbound },
          codec: entry.options?.codec,
          onError: entry.options?.onError,
          middleware: options.middleware ?? entry.options?.middleware,
        });
        await handle.start();
        instance[BRIDGE_HANDLE] = handle;
        handles.push(handle);
      } else {
        handles.push(await instance.$startBridge());
      }
    }
  }

  return handles;
}
