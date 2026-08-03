import type { ConfigSchema } from './types.ts';

/**
 * Wrap a parse function as a {@link ConfigSchema}.
 */
export function schemaFromParse<T>(parse: (input: unknown) => T): ConfigSchema<T> {
  return { parse };
}

/**
 * Identity schema — useful when you only want typed defaults without validation.
 */
export function identitySchema<T>(): ConfigSchema<T> {
  return {
    parse(input: unknown) {
      return input as T;
    },
  };
}
