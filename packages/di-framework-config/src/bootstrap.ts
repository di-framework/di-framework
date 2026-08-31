import { loadConfig, loadConfigSync } from './load.ts';
import { registerConfig } from './register.ts';
import type { LoadConfigOptions, RegisterConfigOptions } from './types.ts';

export type LoadAndRegisterOptions<T extends Record<string, unknown> = Record<string, unknown>> =
  LoadConfigOptions<T> & RegisterConfigOptions;

/**
 * `loadConfig` then `registerConfig`.
 */
export async function loadAndRegisterConfig<
  T extends Record<string, unknown> = Record<string, unknown>,
>(options: LoadAndRegisterOptions<T> = {}): Promise<T> {
  const { token, flatten, container, ...loadOpts } = options;
  const config = await loadConfig<T>(loadOpts);
  return registerConfig(config, { token, flatten, container });
}

/**
 * Sync variant of {@link loadAndRegisterConfig}.
 */
export function loadAndRegisterConfigSync<
  T extends Record<string, unknown> = Record<string, unknown>,
>(options: LoadAndRegisterOptions<T> = {}): T {
  const { token, flatten, container, ...loadOpts } = options;
  const config = loadConfigSync<T>(loadOpts);
  return registerConfig(config, { token, flatten, container });
}
