import { readFileSync } from 'node:fs';
import type { ConfigSource } from '../types.ts';

export interface JsonFileSourceOptions {
  /** When true, missing files yield `{}` instead of throwing. Default `false`. */
  optional?: boolean;
}

/**
 * Load a JSON file as a config object.
 */
export function jsonFileSource(path: string, options: JsonFileSourceOptions = {}): ConfigSource {
  return {
    name: `json:${path}`,
    load() {
      try {
        const text = readFileSync(path, 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`JSON config at ${path} must be an object`);
        }
        return parsed as Record<string, unknown>;
      } catch (err) {
        if (options.optional && isNotFound(err)) return {};
        throw err;
      }
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
