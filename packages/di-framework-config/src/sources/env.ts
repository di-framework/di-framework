import { coerceEnvValue, transformKeySegment } from '../coerce.ts';
import { setByPath } from '../path.ts';
import type { ConfigKeyCase, ConfigSource } from '../types.ts';

export interface EnvSourceOptions {
  /** Only include keys starting with this prefix (stripped from the result). */
  prefix?: string;
  /**
   * Split remaining key on this separator for nesting.
   * Default `'__'` so `APP_DB__HOST` → `{ db: { host } }` after prefix strip + keyCase.
   */
  separator?: string;
  /** How to transform each path segment. Default `'camel'`. */
  keyCase?: ConfigKeyCase;
  /** Coerce string values to number/boolean/JSON. Default `true`. */
  coerce?: boolean;
  /** Env bag to read. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Load configuration from environment variables.
 *
 * @example
 * // APP_PORT=3000 APP_DB__HOST=localhost
 * envSource({ prefix: 'APP_' })
 * // → { port: 3000, db: { host: 'localhost' } }
 */
export function envSource(options: EnvSourceOptions = {}): ConfigSource {
  const prefix = options.prefix ?? '';
  const separator = options.separator ?? '__';
  const keyCase = options.keyCase ?? 'camel';
  const coerce = options.coerce !== false;

  return {
    name: 'env',
    load() {
      const bag = options.env ?? process.env;
      const out: Record<string, unknown> = {};

      for (const [rawKey, rawValue] of Object.entries(bag)) {
        if (rawValue === undefined) continue;
        if (prefix && !rawKey.startsWith(prefix)) continue;

        const stripped = prefix ? rawKey.slice(prefix.length) : rawKey;
        if (!stripped) continue;

        const segments = stripped
          .split(separator)
          .filter(Boolean)
          .map((s) => transformKeySegment(s, keyCase));
        if (segments.length === 0) continue;

        const path = segments.join('.');
        const value = coerce ? coerceEnvValue(rawValue) : rawValue;
        setByPath(out, path, value);
      }

      return out;
    },
  };
}
