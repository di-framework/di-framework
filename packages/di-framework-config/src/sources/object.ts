import type { ConfigSource } from '../types.ts';

/**
 * Static object source — useful for defaults, tests, and programmatic overrides.
 */
export function objectSource(value: Record<string, unknown>, name = 'object'): ConfigSource {
  return {
    name,
    load() {
      return { ...value };
    },
  };
}
