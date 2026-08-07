import { describe, expect, it } from 'bun:test';
import { Arg, Connection, Field, Lookup, Portal } from '../src/decorators.ts';
import { SemanticSchemaError } from '../src/errors.ts';
import { withRegistry } from './helpers.ts';

describe('decorator guard branches', () => {
  it('@Field throws when applied to a static member', () => {
    withRegistry((registry) => {
      expect(() => {
        @Portal()
        class StaticPortal {
          @Field(() => String)
          static staticMethod(): string {
            return 'static';
          }
        }
      }).toThrow(/not supported on static members/);
    });
  });

  it('@Connection throws when applied to a static member', () => {
    withRegistry((registry) => {
      expect(() => {
        @Portal()
        class StaticConnectionPortal {
          @Connection(() => String)
          static staticMethod(): string[] {
            return [];
          }
        }
      }).toThrow(/@Connection is not supported on static members/);
    });
  });

  it('@Arg with string name and TypeRef throws when used on a constructor', () => {
    withRegistry((registry) => {
      expect(() => {
        @Portal()
        class ConstructorArgPortal {
          constructor(@Arg('value', () => String) value: string) {}
        }
      }).toThrow(/GraphQL parameter decorators are only supported on methods, not constructors/);
    });
  });

  it('@Arg with string name and TypeRef on a method works normally', () => {
    withRegistry((registry) => {
      @Portal()
      class NormalArgPortal {
        query(@Arg('id', () => String) id: string): string {
          return id;
        }
      }

      expect(NormalArgPortal).toBeDefined();
    });
  });

  it('@Arg with options object and TypeRef on a method works normally', () => {
    withRegistry((registry) => {
      @Portal()
      class OptionsArgPortal {
        query(@Arg({ name: 'id', type: () => String }) id: string): string {
          return id;
        }
      }

      expect(OptionsArgPortal).toBeDefined();
    });
  });

  it('@Lookup throws when applied to a non-static method', () => {
    withRegistry((registry) => {
      expect(() => {
        @Portal()
        class NonStaticLookupPortal {
          @Lookup()
          async loadItem(): Promise<string> {
            return 'item';
          }
        }
      }).toThrow(/@Lookup must be applied to a static method/);
    });
  });
});
