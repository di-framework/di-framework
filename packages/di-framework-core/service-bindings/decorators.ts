import { defineMetadata, getOwnMetadata, useContainer } from '../container';
import { createServiceBindingClient, serviceBindingToken } from './proxy';
import { ServiceBindingRuntime } from './runtime';
import type { ServiceBindingOptions, ServiceExportOptions } from './types';

export const SERVICE_EXPORT_METADATA_KEY = 'di:service-export';
export const SERVICE_BINDING_METADATA_KEY = 'di:service-binding';
export const EXPORT_OPERATION_METADATA_KEY = 'di:export-operation';
const INJECT_METADATA_KEY = 'di:inject';

/**
 * Marks a class as an exported service exposing operations to bound callers.
 *
 * @example
 * @Container()
 * @ExportService({ name: 'inventory', operations: ['reserve', 'release'] })
 * export class InventoryService {
 *   async reserve(items: any[]) { ... }
 *   async release(id: string) { ... }
 * }
 */
export function ExportService(options: string | ServiceExportOptions) {
  const resolvedOptions: ServiceExportOptions =
    typeof options === 'string' ? { name: options } : options;

  // biome-ignore lint/suspicious/noExplicitAny: class decorator constructor
  return <T extends { new (...args: any[]): object }>(ctor: T): T => {
    defineMetadata(SERVICE_EXPORT_METADATA_KEY, resolvedOptions, ctor);

    // Register with runtime
    const runtime = ServiceBindingRuntime.current;
    runtime.registerExportedService(ctor, resolvedOptions);

    return ctor;
  };
}

/**
 * Method decorator marking a specific method as an exported operation.
 */
export function ExportOperation() {
  // biome-ignore lint/suspicious/noExplicitAny: method decorator
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const existing: string[] = getOwnMetadata(EXPORT_OPERATION_METADATA_KEY, target) || [];
    existing.push(String(propertyKey));
    defineMetadata(EXPORT_OPERATION_METADATA_KEY, existing, target);
    return descriptor;
  };
}

/**
 * Injects a private service-to-service binding into a constructor parameter or property.
 *
 * @example Constructor injection
 * @Container()
 * export class CheckoutService {
 *   constructor(@ServiceBinding('inventory') private inventory: InventoryClient) {}
 * }
 *
 * @example Property injection
 * @Container()
 * export class CheckoutService {
 *   @ServiceBinding('inventory')
 *   private inventory!: InventoryClient;
 * }
 */
export function ServiceBinding(bindingName: string, options: ServiceBindingOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: decorator target
  return (targetClass: any, propertyKey?: string | symbol, parameterIndex?: number) => {
    const callerName =
      options.caller ??
      (typeof targetClass === 'function' ? targetClass.name : targetClass?.constructor?.name);

    const token = serviceBindingToken(bindingName, callerName);

    // Ensure container has a default factory for this service binding token if not present
    try {
      const container = useContainer();
      if (!container.has(token)) {
        container.registerFactory(
          token,
          () => createServiceBindingClient(bindingName, { ...options, caller: callerName }),
          { singleton: true },
        );
      }
    } catch {
      // Container may not be initialized yet; fallback handled on resolution/getter
    }

    // Property injection
    if (propertyKey !== undefined && parameterIndex === undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[propertyKey as string] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      if (targetClass.constructor && targetClass.constructor !== Object) {
        const ctorMetadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass.constructor) || {};
        ctorMetadata[propertyKey as string] = token;
        defineMetadata(INJECT_METADATA_KEY, ctorMetadata, targetClass.constructor);
      }

      // Record binding metadata
      const bindingMeta = getOwnMetadata(SERVICE_BINDING_METADATA_KEY, targetClass) || {};
      bindingMeta[propertyKey as string] = {
        bindingName,
        options: { ...options, caller: callerName },
      };
      defineMetadata(SERVICE_BINDING_METADATA_KEY, bindingMeta, targetClass);

      // Define property getter fallback per-instance
      const cacheSymbol = Symbol(`di:binding:${String(propertyKey)}`);
      Object.defineProperty(targetClass, propertyKey, {
        configurable: true,
        enumerable: true,
        get() {
          if ((this as any)[cacheSymbol] !== undefined) {
            return (this as any)[cacheSymbol];
          }

          // Attempt container resolution first
          try {
            const container = useContainer();
            if (container && typeof container.resolve === 'function') {
              const res = container.resolve(token);
              if (res !== undefined && res !== null) {
                (this as any)[cacheSymbol] = res;
                return res;
              }
            }
          } catch {
            // fall through to client proxy creation
          }

          const client = createServiceBindingClient(bindingName, {
            ...options,
            caller: callerName,
          });
          (this as any)[cacheSymbol] = client;
          return client;
        },
        set(value: unknown) {
          (this as any)[cacheSymbol] = value;
        },
      });
    }
    // Constructor parameter injection
    else if (parameterIndex !== undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[`param_${parameterIndex}`] = token;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      const bindingMeta = getOwnMetadata(SERVICE_BINDING_METADATA_KEY, targetClass) || {};
      bindingMeta[`param_${parameterIndex}`] = {
        bindingName,
        options: { ...options, caller: callerName },
      };
      defineMetadata(SERVICE_BINDING_METADATA_KEY, bindingMeta, targetClass);
    }
  };
}
