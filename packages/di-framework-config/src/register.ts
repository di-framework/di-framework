import { useContainer } from '@di-framework/core/container';
import { flattenEntries } from './path.ts';
import type { ConfigContainer, RegisterConfigOptions } from './types.ts';

function asContainer(value: unknown): ConfigContainer {
  return (value ?? useContainer()) as ConfigContainer;
}

/**
 * Register a config object on the DI container under `token` (default `'config'`).
 * When `flatten` is true (default), also registers every dotted path as its own factory
 * so `@Component('config.db.host')` / `@Value('db.host')` work.
 */
export function registerConfig<T>(config: T, options: RegisterConfigOptions = {}): T {
  const token = options.token ?? 'config';
  const flatten = options.flatten !== false;
  const container = asContainer(options.container);

  if (!container.registerFactory) {
    throw new Error('Container does not support registerFactory');
  }

  container.registerFactory(token, () => config, { singleton: true });

  if (flatten && config !== null && typeof config === 'object' && !Array.isArray(config)) {
    for (const [path, value] of flattenEntries(config as Record<string, unknown>)) {
      const childToken = `${token}.${path}`;
      container.registerFactory(childToken, () => value, { singleton: true });
    }
  }

  return config;
}
