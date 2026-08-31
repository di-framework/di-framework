import { Component, Container as ContainerDecorator } from '@di-framework/core/decorators';
import { loadConfigSync } from './load.ts';
import { getWithProfiles, storeWithProfiles } from './profiles.ts';
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
 * Prefer sync sources (`envSource`, `objectSource`, `jsonFileSource`, `yamlFileSource`, `tomlFileSource`) with this decorator.
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
const configurationPending = new WeakMap<
  Ctor,
  { original: Ctor; options: ConfigurationDecoratorOptions }
>();

function applyConfiguration<T extends Record<string, unknown>, C extends Ctor>(
  original: C,
  options: ConfigurationDecoratorOptions<T>,
  profiles: readonly string[] | undefined,
): C {
  const classDefaults = defaultsFromClass(original);
  const defaults = {
    ...classDefaults,
    ...(options.defaults ?? {}),
  };

  const config = loadConfigSync<T>({
    sources: options.sources,
    defaults,
    schema: options.schema,
    profiles,
  });

  registerConfig(config, {
    token: options.token ?? 'config',
    flatten: options.flatten,
    container: options.container,
  });

  const registerClass = options.registerClass !== false;
  if (!registerClass) return original;

  const singleton = options.singleton ?? true;

  const ConfigClass = class extends original {
    // biome-ignore lint/suspicious/noExplicitAny: mirrors decorated class arity
    constructor(...args: any[]) {
      super(...args);
      Object.assign(this, config as object);
    }
  };

  Object.defineProperty(ConfigClass, 'name', { value: original.name });

  ContainerDecorator({
    singleton,
    container: options.container as never,
  })(ConfigClass);

  configurationPending.set(ConfigClass as Ctor, {
    original,
    options: options as ConfigurationDecoratorOptions,
  });
  return ConfigClass as C;
}

/**
 * Selects config profiles for a `@Configuration` class.
 *
 * File sources overlay `{profile}.config.{ext}` from the same directory as the
 * base file, later profiles winning.
 *
 * @example
 * @WithProfile('dev')
 * @Configuration({ sources: [yamlFileSource('./config.yaml')] })
 * class AppConfig {}
 */
export function WithProfile(...profiles: string[]) {
  return <C extends Ctor>(target: C): C => {
    storeWithProfiles(target, profiles);
    const pending = configurationPending.get(target);
    if (!pending) return target;
    return applyConfiguration(pending.original, pending.options, profiles) as C;
  };
}

export function Configuration<T extends Record<string, unknown> = Record<string, unknown>>(
  options: ConfigurationDecoratorOptions<T> = {},
) {
  return <C extends Ctor>(target: C): C => {
    return applyConfiguration(target, options, getWithProfiles(target) ?? options.profiles);
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
