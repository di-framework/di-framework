/**
 * Interfaces and unions: SDL shape, executable behaviour, concrete-type
 * resolution and how both interact with bounded-context boundaries.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import {
  Arg,
  BoundedContext,
  Field,
  Implements,
  InterfaceType,
  Portal,
  registerUnion,
  SemanticType,
} from '../src/decorators.ts';
import { SemanticBoundaryError, SemanticSchemaError } from '../src/errors.ts';
import { ID, Int } from '../src/scalars.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { printSDL } from '../src/sdl.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

describe('GraphQL interfaces', () => {
  it('emits the interface, its implementations and inherited fields in SDL', () => {
    const graph = withRegistry((registry) => {
      @InterfaceType({ description: 'Anything addressable by a global id.' })
      abstract class Node {
        @Field(() => ID) id!: string;
      }

      @Implements(() => Node)
      @SemanticType()
      class User extends Node {
        @Field(() => String) email!: string;
      }

      @Portal()
      class Query {
        @Field(() => User)
        user(): User {
          return new User();
        }
      }

      return buildTypeGraph({ registry });
    });

    const sdl = printSDL(graph);
    expect(sdl).toContain('interface Node {');
    expect(sdl).toContain('type User implements Node {');
    // `id` is declared only on the interface, so it must be copied down.
    expect(
      graph.objects.find((object) => object.name === 'User')?.fields.map((f) => f.name),
    ).toEqual(expect.arrayContaining(['email', 'id']));
    expect(graph.interfaces[0]?.implementations).toEqual(['User']);
  });

  it('lets an implementation override an inherited interface field', async () => {
    const api = withRegistry(() => {
      @InterfaceType()
      abstract class Named {
        @Field(() => String)
        label(): string {
          return 'interface';
        }
      }

      @Implements(() => Named)
      @SemanticType()
      class Product extends Named {
        @Field(() => String)
        override label(): string {
          return 'product';
        }
      }

      @Portal()
      class Query {
        @Field(() => Named)
        thing(): Named {
          return new Product();
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({ query: '{ thing { label __typename } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.thing).toEqual({ label: 'product', __typename: 'Product' });
  });

  it('hydrates plain data onto the concrete class named by __typename', async () => {
    const api = withRegistry(() => {
      @InterfaceType()
      abstract class Node {
        @Field(() => ID) id!: string;
      }

      @Implements(() => Node)
      @SemanticType()
      class Article extends Node {
        @Field(() => String) title!: string;

        @Field(() => String)
        slug(): string {
          return this.title.toLowerCase().replaceAll(' ', '-');
        }
      }

      @Portal()
      class Query {
        // A repository would hand back exactly this: correct shape, no class.
        @Field(() => Node)
        node(): any {
          return { __typename: 'Article', id: '1', title: 'Hello World' };
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({
      query: '{ node { id __typename ... on Article { title slug } } }',
    });
    expect(result.errors).toBeUndefined();
    // `slug` proves the plain object was hydrated onto Article before dispatch.
    expect(result.data?.node).toEqual({
      id: '1',
      __typename: 'Article',
      title: 'Hello World',
      slug: 'hello-world',
    });
  });

  it('honours an explicit resolveType over instanceof matching', async () => {
    const api = withRegistry(() => {
      @InterfaceType({ resolveType: (value: any) => (value.legs === 4 ? 'Dog' : 'Bird') })
      abstract class Animal {
        @Field(() => Int) legs!: number;
      }

      @Implements(() => Animal)
      @SemanticType()
      class Dog extends Animal {}

      @Implements(() => Animal)
      @SemanticType()
      class Bird extends Animal {}

      @Portal()
      class Query {
        @Field(() => Animal)
        animal(): any {
          return { legs: 4 };
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({ query: '{ animal { legs __typename } }' });
    expect(result.data?.animal).toEqual({ legs: 4, __typename: 'Dog' });
  });

  it('awaits an explicit resolveType that returns a promise, falling back to instanceof when it resolves undefined', async () => {
    const api = withRegistry(() => {
      @InterfaceType({ resolveType: async (value: any) => (value.legs === 4 ? 'Dog' : undefined) })
      abstract class Animal {
        @Field(() => Int) legs!: number;
      }

      @Implements(() => Animal)
      @SemanticType()
      class Dog extends Animal {}

      @Implements(() => Animal)
      @SemanticType()
      class Bird extends Animal {}

      @Portal()
      class Query {
        @Field(() => [Animal])
        animals(): any[] {
          return [{ legs: 4 }, Object.assign(new Bird(), { legs: 2 })];
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({ query: '{ animals { legs __typename } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.animals).toEqual([
      { legs: 4, __typename: 'Dog' },
      { legs: 2, __typename: 'Bird' },
    ]);
  });

  it('rejects an implementation whose field type contradicts the interface', () => {
    expect(() =>
      withRegistry((registry) => {
        @InterfaceType()
        abstract class Node {
          @Field(() => ID) id!: string;
        }

        // Implements structurally rather than by extending, so `id` is its own
        // declaration — and contradicts the interface's ID.
        @Implements(() => Node)
        @SemanticType()
        class Broken {
          @Field(() => Int) id!: number;
        }

        @Portal()
        class Query {
          @Field(() => Broken)
          broken(): Broken {
            return new Broken();
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(SemanticBoundaryError);
  });

  it('rejects implementing something that is not an interface', () => {
    expect(() =>
      withRegistry((registry) => {
        @SemanticType()
        class NotAnInterface {
          @Field(() => ID) id!: string;
        }

        @Implements(() => NotAnInterface)
        @SemanticType()
        class Thing {
          @Field(() => ID) id!: string;
        }

        @Portal()
        class Query {
          @Field(() => Thing)
          thing(): Thing {
            return new Thing();
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(SemanticSchemaError);
  });

  it('rejects an interface with no fields', () => {
    expect(() =>
      withRegistry((registry) => {
        @InterfaceType()
        abstract class Empty {}

        @Implements(() => Empty)
        @SemanticType()
        class Thing extends Empty {
          @Field(() => ID) id!: string;
        }

        @Portal()
        class Query {
          @Field(() => Thing)
          thing(): Thing {
            return new Thing();
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(/at least one @Field/);
  });
});

describe('GraphQL unions', () => {
  it('emits a union and resolves each member at runtime', async () => {
    const api = withRegistry(() => {
      @SemanticType()
      class Book {
        @Field(() => String) title!: string;
      }

      @SemanticType()
      class Author {
        @Field(() => String) name!: string;
      }

      const SearchResult = registerUnion('SearchResult', () => [Book, Author], {
        description: 'Anything the catalogue can return.',
      });

      @Portal()
      class Query {
        @Field(() => [SearchResult])
        search(@Arg('q', () => String) q: string): any[] {
          return q === 'all'
            ? [
                Object.assign(new Book(), { title: 'Dune' }),
                Object.assign(new Author(), { name: 'Herbert' }),
              ]
            : [];
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    expect(api.sdl).toContain('union SearchResult = Author | Book');

    const result = await api.execute({
      query: '{ search(q: "all") { __typename ... on Book { title } ... on Author { name } } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.search).toEqual([
      { __typename: 'Book', title: 'Dune' },
      { __typename: 'Author', name: 'Herbert' },
    ]);
  });

  it('rejects a union member that is not a semantic type', () => {
    expect(() =>
      withRegistry((registry) => {
        class Loose {}

        @SemanticType()
        class Book {
          @Field(() => String) title!: string;
        }

        const Mixed = registerUnion('Mixed', () => [Book, Loose]);

        @Portal()
        class Query {
          @Field(() => Mixed)
          any(): any {
            return null;
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(/not a @SemanticType/);
  });

  it('rejects an empty union', () => {
    expect(() =>
      withRegistry((registry) => {
        const Nothing = registerUnion('Nothing', () => []);

        @Portal()
        class Query {
          @Field(() => Nothing)
          nothing(): any {
            return null;
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(/no members/);
  });
});

describe('abstract types and bounded contexts', () => {
  it('rejects a union that smuggles a non-boundary type across a context edge', () => {
    expect(() =>
      withRegistry((registry) => {
        @BoundedContext('Billing')
        @SemanticType()
        class Invoice {
          @Field(() => ID) id!: string;
        }

        @BoundedContext('Catalog')
        @SemanticType()
        class Product {
          @Field(() => ID) id!: string;
        }

        const Anything = registerUnion('Anything', () => [Product, Invoice]);

        @BoundedContext('Catalog')
        @Portal()
        class CatalogQuery {
          @Field(() => Anything)
          anything(): any {
            return null;
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(SemanticBoundaryError);
  });

  it('allows a union across contexts when every member is a boundary type', () => {
    const graph = withRegistry((registry) => {
      @BoundedContext('Billing')
      @SemanticType({ boundary: true, key: 'id' })
      class Invoice {
        @Field(() => ID) id!: string;
      }

      @BoundedContext('Catalog')
      @SemanticType({ boundary: true, key: 'id' })
      class Product {
        @Field(() => ID) id!: string;
      }

      const Anything = registerUnion('Anything', () => [Product, Invoice]);

      @BoundedContext('Catalog')
      @Portal()
      class CatalogQuery {
        @Field(() => Anything)
        anything(): any {
          return null;
        }
      }

      return buildTypeGraph({ registry });
    });

    expect(graph.unions[0]?.members).toEqual(['Invoice', 'Product']);
  });

  it('rejects an interface reference whose implementation is not a boundary type', () => {
    expect(() =>
      withRegistry((registry) => {
        @InterfaceType()
        abstract class Payable {
          @Field(() => ID) id!: string;
        }

        @BoundedContext('Billing')
        @Implements(() => Payable)
        @SemanticType()
        class Invoice extends Payable {}

        @BoundedContext('Catalog')
        @Portal()
        class CatalogQuery {
          @Field(() => Payable)
          payable(): any {
            return null;
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(SemanticBoundaryError);
  });
});
