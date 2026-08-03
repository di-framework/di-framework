import { Component, Container as ContainerDecorator } from '@di-framework/core/decorators';
import { loadConfigSync } from './load.ts';
import { registerConfig } from './register.ts';
import type { ConfigurationDecoratorOptions, ValueDecoratorOptions } from './types.ts';

// biome-ignore lint/suspicious/noExplicitAny: decorator targets are heterogeneous class constructors
type Ctor = new (...args: any[]) => any;

function defaultsFromClass(ctor: Ctor): Record<string, unknown> {
  try {
    const instance = new ctor();
    if (instance === null || typeof instance !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(instance as Record<string, unknown>)) {
      if (value !== undefined) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Marks a class as a configuration definition.
 *
 * 1. Builds defaults from property initializers on a fresh instance
 * 2. Loads + merges sources (sync) and optional schema
 * 3. Registers the result under `token` (default `'config'`) with flattened paths
 * 4. Optionally registers the class itself as a singleton holding the loaded values
 *
 * Prefer sync sources (`envSource`, `objectSource`, `jsonFileSource`) with this decorator.
 * For async sources, use `loadAndRegisterConfig` instead.
 *
 * @example
 * @Configuration({
 *   sources: [envSource({ prefix: 'APP_' })],
 *   defaults: { port: 3000 },
 * })
 * class AppConfig {
 *   host = 'localhost';
 *   port = 3000;
 * }
 */
export function Configuration<T = Record<string, unknown>>(
  options: ConfigurationDecoratorOptions<T> = {},
) {
  return <C extends Ctor>(target: C): C => {
    const classDefaults = defaultsFromClass(target);
    const defaults = {
      ...classDefaults,
      ...(options.defaults ?? {}),
    };

    const config = loadConfigSync<T>({
      sources: options.sources,
      defaults,
      schema: options.schema,
    });

    registerConfig(config, {
      token: options.token ?? 'config',
      flatten: options.flatten,
      container: options.container,
    });

    const registerClass = options.registerClass !== false;
    if (!registerClass) return target;

    const singleton = options.singleton ?? true;

    // Subclass so construction applies the loaded snapshot (same idea as @EventBridge autoStart).
    const ConfigClass = class extends target {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors decorated class arity
      constructor(...args: any[]) {
        super(...args);
        Object.assign(this, config as object);
      }
    };

    Object.defineProperty(ConfigClass, 'name', { value: target.name });

    ContainerDecorator({
      singleton,
      container: options.container as never,
    })(ConfigClass);

    return ConfigClass as C;
  };
}

/**
 * Inject a nested config value by dotted path under the root config token.
 *
 * Equivalent to `@Component('config.<path>')` when flatten registration is enabled.
 *
 * @example
 * @Container()
 * class DatabaseService {
 *   @Value('database.host')
 *   host!: string;
 *
 *   constructor(@Value('database.port') port: number) {}
 * }
 */
export function Value(path: string, options: ValueDecoratorOptions = {}) {
  const token = options.token ?? 'config';
  const full = path ? `${token}.${path}` : token;
  return Component(full);
}
