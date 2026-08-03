import { deepMerge } from './path.ts';
import type { LoadConfigOptions } from './types.ts';

/**
 * Load configuration by deep-merging defaults + sources (left → right),
 * then optionally validating with a schema.
 *
 * Sources may be sync or async; this always returns a Promise.
 */
export async function loadConfig<T = Record<string, unknown>>(
  options: LoadConfigOptions<T> = {},
): Promise<T> {
  let merged: Record<string, unknown> = { ...(options.defaults ?? {}) };

  for (const source of options.sources ?? []) {
    const label = source.name ?? 'source';
    try {
      const loaded = await Promise.resolve(source.load());
      merged = deepMerge(merged, loaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load config from ${label}: ${message}`, { cause: err });
    }
  }

  if (options.schema) {
    return options.schema.parse(merged);
  }

  return merged as T;
}

/**
 * Synchronous variant — all sources must return plain objects (not Promises).
 */
export function loadConfigSync<T = Record<string, unknown>>(options: LoadConfigOptions<T> = {}): T {
  let merged: Record<string, unknown> = { ...(options.defaults ?? {}) };

  for (const source of options.sources ?? []) {
    const label = source.name ?? 'source';
    const loaded = source.load();
    if (loaded instanceof Promise) {
      throw new Error(
        `Config source "${label}" is async; use loadConfig() instead of loadConfigSync()`,
      );
    }
    merged = deepMerge(merged, loaded);
  }

  if (options.schema) {
    return options.schema.parse(merged);
  }

  return merged as T;
}
