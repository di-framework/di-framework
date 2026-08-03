import type { ConfigSchema } from '../types.ts';

/** Minimal Zod-like surface so we don't hard-depend on Zod types at compile time. */
export interface ZodTypeLike<T = unknown> {
  parse(input: unknown): T;
}

/**
 * Adapt a Zod schema to {@link ConfigSchema}.
 *
 * @example
 * import { z } from 'zod';
 * import { zodSchema } from '@di-framework/config/zod';
 *
 * const schema = zodSchema(z.object({ port: z.number().default(3000) }));
 */
export function zodSchema<T>(zod: ZodTypeLike<T>): ConfigSchema<T> {
  return {
    parse(input: unknown) {
      return zod.parse(input);
    },
  };
}
