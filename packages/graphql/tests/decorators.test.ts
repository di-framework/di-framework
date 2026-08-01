import { describe, expect, it } from 'bun:test';
import { Action, Arg, BoundedContext, Field, Portal, SemanticType } from '../src/decorators.ts';
import { DateTime, Int } from '../src/scalars.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { printSDL } from '../src/sdl.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

describe('field declarations', () => {
  it('assumes String for an undeclared type, and refuses to in strict mode', () => {
    withRegistry((registry) => {
      @Portal()
      class BarePortal {
        @Field()
        greeting(): string {
          return 'hello';
        }
      }

      const graph = buildTypeGraph({ registry });
      expect(graph.query.fields[0]?.type).toEqual({
        kind: 'nonNull',
        of: { kind: 'scalar', name: 'String' },
      });
      expect(() => buildTypeGraph({ registry, strictTypes: true })).toThrow(/no type declared/);
    });
  });

  it('is non-null by default and nullable on request', () => {
    withRegistry((registry) => {
      @Portal()
      class NullabilityPortal {
        @Field(() => String, { nullable: true })
        maybe(): string | null {
          return null;
        }

        @Field(() => [String], { nullable: true, nullableItems: true })
        loose(): Array<string | null> {
          return [null];
        }

        @Field(() => [String])
        strict(): string[] {
          return [];
        }
      }

      const graph = buildTypeGraph({ registry });
      const sdl = printSDL(graph);
      expect(sdl).toContain('maybe: String');
      expect(sdl).toContain('loose: [String]');
      expect(sdl).toContain('strict: [String!]!');
    });
  });

  it('reads argument names from the method signature', () => {
    withRegistry((registry) => {
      @Portal()
      class ArgsPortal {
        @Field(() => String, { args: { suffix: { type: () => String, nullable: true } } })
        greet(name: string, suffix?: string): string {
          return `${name}${suffix ?? ''}`;
        }

        @Field(() => Int)
        add(@Arg('left', () => Int) left: number, @Arg('right', () => Int, { defaultValue: 1 }) right: number): number {
          return left + right;
        }
      }

      const graph = buildTypeGraph({ registry });
      const sdl = printSDL(graph);
      expect(sdl).toContain('greet(name: String!, suffix: String): String!');
      expect(sdl).toContain('add(left: Int!, right: Int! = 1): Int!');
    });
  });

  it('renames and deprecates fields', () => {
    withRegistry((registry) => {
      @Portal()
      class RenamePortal {
        @Field(() => String, { name: 'currentVersion', deprecated: 'Use build instead' })
        version(): string {
          return '1';
        }
      }

      const sdl = printSDL(buildTypeGraph({ registry }));
      expect(sdl).toContain('currentVersion: String! @deprecated(reason: "Use build instead")');
    });
  });

  it('inherits the exposure declared on a base class', () => {
    withRegistry((registry) => {
      @SemanticType()
      class Document {
        @Field(() => String)
        kind(): string {
          return 'document';
        }
      }

      @SemanticType()
      class Invoice extends Document {
        @Field(() => Int)
        lines(): number {
          return 2;
        }

        override kind(): string {
          return 'invoice';
        }
      }

      const graph = buildTypeGraph({ registry });
      const invoice = graph.objects.find((object) => object.name === 'Invoice');
      expect(invoice?.fields.map((field) => field.name).sort()).toEqual(['kind', 'lines']);
    });
  });

  it('serializes the DateTime scalar', async () => {
    await withRegistry(async (registry) => {
      @Portal()
      class ClockPortal {
        @Field(() => DateTime)
        now(): Date {
          return new Date('2020-01-02T03:04:05.000Z');
        }
      }

      const api = buildSemanticSchema({ registry });
      expect(api.sdl).toContain('scalar DateTime');

      const result = await api.execute({ query: '{ now }' });
      expect(result.data?.now).toBe('2020-01-02T03:04:05.000Z');
    });
  });

  it('falls back to a _contexts query when only mutations are declared', async () => {
    await withRegistry(async (registry) => {
      @BoundedContext('Ops')
      @Portal()
      class MutationOnlyPortal {
        @Action(() => String)
        ping(): string {
          return 'pong';
        }
      }

      const api = buildSemanticSchema({ registry });
      expect(api.graph.query.fields.map((field) => field.name)).toEqual(['_contexts']);
      expect(api.graph.mutation?.fields.map((field) => field.name)).toEqual(['ping']);

      const result = await api.execute({ query: '{ _contexts }' });
      expect(result.data?._contexts).toEqual(['Ops']);
    });
  });
});
