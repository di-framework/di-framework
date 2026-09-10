import { ServiceBindingRuntime } from './runtime';
import type { ServiceBindingOptions } from './types';

export interface ServiceBindingClientMetadata {
  bindingName: string;
  caller: string;
  target?: string;
}

export function serviceBindingToken(bindingName: string, caller?: string): string {
  return caller ? `service-binding:${caller}:${bindingName}` : `service-binding:${bindingName}`;
}

/**
 * Creates a strongly-typed invocation proxy for a named service-to-service binding.
 */
export function createServiceBindingClient<T = any>(
  bindingName: string,
  options: ServiceBindingOptions = {},
  runtime: ServiceBindingRuntime = ServiceBindingRuntime.current,
): T {
  const caller = options.caller ?? runtime.getCurrentServiceId();

  const meta: ServiceBindingClientMetadata = {
    bindingName,
    caller,
    target: options.target,
  };

  const proxy = new Proxy(
    {},
    {
      get(_target, prop, _receiver) {
        if (typeof prop !== 'string') {
          return undefined;
        }

        if (prop === '$bindingMeta') {
          return meta;
        }

        if (prop === 'toString') {
          return () => `[ServiceBindingClient:${caller}->${bindingName}]`;
        }

        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return undefined;
        }

        return async (...args: any[]) => {
          return await runtime.invoke(caller, bindingName, prop, args, options.target);
        };
      },
      has(_target, prop) {
        if (typeof prop === 'string' && (prop === '$bindingMeta' || prop === 'toString')) {
          return true;
        }
        return true;
      },
    },
  );

  return proxy as unknown as T;
}
