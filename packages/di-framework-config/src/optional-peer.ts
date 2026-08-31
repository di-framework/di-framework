import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Load an optional peer dependency. Callers that only use env/JSON never hit this.
 */
export function requireOptionalPeer<T>(specifier: string, guidance: string): T {
  try {
    return require(specifier) as T;
  } catch (err) {
    throw new Error(guidance, { cause: err });
  }
}
