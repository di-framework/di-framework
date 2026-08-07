import { describe, expect, it } from 'bun:test';
import { Kind } from 'graphql';
import { Field, Portal, registerEnum } from '../src/decorators.ts';
import { SemanticRegistry, setRegistry } from '../src/registry.ts';
import { printSDL } from '../src/sdl.ts';
import { buildTypeGraph } from '../src/type-graph.ts';

function withFreshRegistry<T>(fn: (registry: SemanticRegistry) => T): T {
  const fresh = new SemanticRegistry();
  const prev = setRegistry(fresh);
  try {
    return fn(fresh);
  } finally {
    setRegistry(prev);
  }
}

describe('SDL printer - enum coverage', () => {
  it('emits enums with descriptions when referenced by a field', () => {
    const OrderState = { Pending: 'Pending', Shipped: 'Shipped' } as const;

    const graph = withFreshRegistry((registry) => {
      registerEnum(OrderState, {
        name: 'OrderState',
        description: 'Lifecycle of an order',
      });

      @Portal()
      class Query {
        @Field(() => OrderState)
        state(): any {
          return 'Pending';
        }
      }

      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph);
    expect(sdl).toContain('enum OrderState');
    expect(sdl).toContain('Lifecycle of an order');
  });

  it('emits enums without descriptions when descriptions is false', () => {
    const SimpleEnum = { Active: 'Active' } as const;

    const graph = withFreshRegistry((registry) => {
      registerEnum(SimpleEnum, {
        name: 'SimpleEnum',
      });

      @Portal()
      class Query {
        @Field(() => SimpleEnum)
        state(): any {
          return 'Active';
        }
      }

      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph, { descriptions: false });
    expect(sdl).toContain('enum SimpleEnum');
    expect(sdl).not.toContain('description');
  });
});

describe('SDL printer - multiline descriptions', () => {
  it('emits block strings for multiline descriptions', () => {
    const graph = withFreshRegistry((registry) => {
      registry.registerType({
        target: class Multiline {},
        name: 'Multiline',
        options: { description: 'Line one.\nLine two.' },
        portal: false,
      });
      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph);
    expect(sdl).toContain('"""');
    expect(sdl).toContain('Line one.');
    expect(sdl).toContain('Line two.');
  });
});

describe('Schema - DateTime scalar edge cases', () => {
  it('DateTime parseValue accepts a string', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    const result = DateTimeScalar.parseValue('2020-01-02T03:04:05.000Z');
    expect(result).toBeInstanceOf(Date);
  });

  it('DateTime parseValue accepts a number (timestamp)', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    const result = DateTimeScalar.parseValue(1577836800000);
    expect(result).toBeInstanceOf(Date);
  });

  it('DateTime parseValue throws for invalid input', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    expect(() => DateTimeScalar.parseValue(true)).toThrow(/DateTime cannot parse value/);
  });

  it('DateTime serialize accepts Date, string, and number', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    expect(DateTimeScalar.serialize(new Date('2020-01-02T00:00:00.000Z'))).toBe(
      '2020-01-02T00:00:00.000Z',
    );
    expect(DateTimeScalar.serialize('2020-01-02T00:00:00.000Z')).toBe('2020-01-02T00:00:00.000Z');
    expect(DateTimeScalar.serialize(1577836800000)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('DateTime serialize throws for invalid input', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    expect(() => DateTimeScalar.serialize(true)).toThrow(/DateTime cannot represent value/);
  });

  it('DateTime parseLiteral accepts a string literal', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    const result = DateTimeScalar.parseLiteral(
      {
        kind: Kind.STRING,
        value: '2020-01-02T03:04:05.000Z',
      },
      undefined,
    );
    expect(result).toBeInstanceOf(Date);
  });

  it('DateTime parseLiteral throws for non-string literal', async () => {
    const DateTimeScalar = (await import('../src/schema.ts')).DateTimeScalar;
    expect(() => DateTimeScalar.parseLiteral({ kind: Kind.INT, value: '42' }, undefined)).toThrow(
      /DateTime must be a string/,
    );
  });
});

describe('Schema - JSON scalar AST parsing', () => {
  it('JSONScalar parseLiteral converts all AST node kinds', async () => {
    const JSONScalar = (await import('../src/schema.ts')).JSONScalar;

    expect(JSONScalar.parseLiteral({ kind: Kind.NULL } as any, undefined)).toBeNull();
    expect(JSONScalar.parseLiteral({ kind: Kind.INT, value: '123' } as any, undefined)).toBe(123);
    expect(JSONScalar.parseLiteral({ kind: Kind.FLOAT, value: '12.34' } as any, undefined)).toBe(
      12.34,
    );
    expect(JSONScalar.parseLiteral({ kind: Kind.BOOLEAN, value: true } as any, undefined)).toBe(
      true,
    );
    expect(JSONScalar.parseLiteral({ kind: Kind.STRING, value: 'hello' } as any, undefined)).toBe(
      'hello',
    );
    expect(JSONScalar.parseLiteral({ kind: Kind.ENUM, value: 'ACTIVE' } as any, undefined)).toBe(
      'ACTIVE',
    );

    // List
    const listNode = {
      kind: Kind.LIST,
      values: [
        { kind: Kind.INT, value: '1' },
        { kind: Kind.STRING, value: 'two' },
      ],
    };
    expect(JSONScalar.parseLiteral(listNode as any, undefined)).toEqual([1, 'two']);

    // Object
    const objectNode = {
      kind: Kind.OBJECT,
      fields: [
        { name: { value: 'a' }, value: { kind: Kind.INT, value: '10' } },
        { name: { value: 'b' }, value: { kind: Kind.BOOLEAN, value: false } },
      ],
    };
    expect(JSONScalar.parseLiteral(objectNode as any, undefined)).toEqual({ a: 10, b: false });

    // Unknown/unsupported kind falls back to null
    expect(JSONScalar.parseLiteral({ kind: Kind.VARIABLE } as any, undefined)).toBeNull();
  });
});

describe('SDL printer - default value literal formatting', () => {
  it('formats argument default values of various types (null, list, object, etc.)', () => {
    const { Arg, Field, Portal } = require('../src/decorators.ts');
    const graph = withFreshRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        testDefaults(
          @Arg('nullArg', () => String, { defaultValue: null }) _n: any,
          @Arg('listArg', () => [String], { defaultValue: ['a', 'b'] }) _l: any,
          @Arg('objArg', () => String, { defaultValue: { x: 1, y: 'two' } }) _o: any,
          @Arg('numArg', () => Number, { defaultValue: 42 }) _num: any,
          @Arg('boolArg', () => Boolean, { defaultValue: true }) _b: any,
        ): string {
          return 'ok';
        }
      }
      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph);
    expect(sdl).toContain('nullArg: String! = null');
    expect(sdl).toContain('listArg: [String!]! = ["a", "b"]');
    expect(sdl).toContain('objArg: String! = {x: 1, y: "two"}');
    expect(sdl).toContain('numArg: Float! = 42');
    expect(sdl).toContain('boolArg: Boolean! = true');
  });

  it('throws when a default value contains a cyclic reference', () => {
    const { Arg, Field, Portal } = require('../src/decorators.ts');
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    const graph = withFreshRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        testCyclicDefault(
          @Arg('cyclicArg', () => String, { defaultValue: cyclic }) _c: any,
        ): string {
          return 'ok';
        }
      }
      return buildTypeGraph({ registry });
    });

    expect(() => printSDL(graph)).toThrow(/detected a cyclic value/);
  });

  it('throws when a default value nests deeper than the max depth', () => {
    const { Arg, Field, Portal } = require('../src/decorators.ts');
    let deep: unknown = 'bottom';
    for (let i = 0; i < 70; i += 1) deep = [deep];

    const graph = withFreshRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        testDeepDefault(@Arg('deepArg', () => [String], { defaultValue: deep }) _d: any): string {
          return 'ok';
        }
      }
      return buildTypeGraph({ registry });
    });

    expect(() => printSDL(graph)).toThrow(/exceeded max depth/);
  });

  it('formats argument default values with fallback types', () => {
    const { Arg, Field, Portal } = require('../src/decorators.ts');
    const graph = withFreshRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        testSymbolDefault(
          @Arg('symArg', () => String, { defaultValue: Symbol('test') as any }) _s: any,
        ): string {
          return 'ok';
        }
      }
      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph);
    expect(sdl).toContain('symArg: String! = Symbol(test)');
  });
});
