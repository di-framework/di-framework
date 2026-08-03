import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { zodSchema } from '../src/adapters/zod.ts';
import { loadConfigSync } from '../src/load.ts';
import { objectSource } from '../src/sources/object.ts';

describe('zodSchema', () => {
  it('parses and applies defaults', () => {
    const schema = zodSchema(
      z.object({
        port: z.coerce.number().default(3000),
        debug: z.boolean().default(false),
      }),
    );

    const config = loadConfigSync({
      sources: [objectSource({ port: '4000' })],
      schema,
    });

    expect(config).toEqual({ port: 4000, debug: false });
  });

  it('throws on invalid input', () => {
    const schema = zodSchema(z.object({ port: z.number() }));
    expect(() =>
      loadConfigSync({
        sources: [objectSource({ port: 'nope' })],
        schema,
      }),
    ).toThrow();
  });
});
