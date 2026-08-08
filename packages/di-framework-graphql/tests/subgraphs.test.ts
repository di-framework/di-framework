/**
 * Per-context slicing into deployable subgraphs: what each slice owns, what it
 * sees of the others, and what is allowed to cross the seam.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import {
  Action,
  BoundedContext,
  Extends,
  Field,
  Lookup,
  Parent,
  Portal,
  SemanticType,
} from '../src/decorators.ts';
import { ID } from '../src/scalars.ts';
import { buildSemanticSchema, buildSemanticSubgraphs } from '../src/schema.ts';
import { printSDL } from '../src/sdl.ts';
import { buildContextSubgraphs, buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

/**
 * Two contexts sharing one boundary type:
 *   Catalog owns Book (boundary, key `id`).
 *   Lending owns Loan, references Book, and contributes `onLoan` to it.
 *   Catalog also owns Shelf, which is internal and must never leave.
 */
function library<T>(build: () => T): T {
  return withRegistry(() => {
    @BoundedContext('Catalog')
    @SemanticType({ boundary: true, key: 'id' })
    class Book {
      id!: string;

      @Field(() => String) title!: string;

      @Field(() => ID)
      shelfCode(): string {
        return 'A1';
      }

      @Action(() => String)
      reshelve(): string {
        return 'moved';
      }

      @Lookup()
      static load(id: string) {
        return Object.assign(new Book(), { id, title: `Title ${id}` });
      }
    }

    @BoundedContext('Catalog')
    @SemanticType()
    class Shelf {
      @Field(() => ID) code!: string;
    }

    @BoundedContext('Lending')
    @SemanticType({ key: 'id' })
    class Loan {
      id!: string;

      @Field(() => ID) id2!: string;

      @Field(() => Book)
      book(): Book {
        return Book.load('b1');
      }
    }

    @BoundedContext('Lending')
    @Extends(() => Book)
    class BookAvailability {
      @Field(() => String)
      onLoan(@Parent() book: Book): string {
        return `${book.id} is available`;
      }
    }

    @BoundedContext('Catalog')
    @Portal()
    class CatalogQuery {
      @Field(() => Book)
      book(): Book {
        return Book.load('b1');
      }

      @Field(() => Shelf)
      shelf(): Shelf {
        return Object.assign(new Shelf(), { code: 'A1' });
      }
    }

    @BoundedContext('Lending')
    @Portal()
    class LendingQuery {
      @Field(() => Loan)
      loan(): Loan {
        return Object.assign(new Loan(), { id: 'l1', id2: 'l1' });
      }
    }

    return build();
  });
}

describe('boundary stubs', () => {
  it('gives a slice the key of a boundary type it does not own', () => {
    const graph = library(() => buildTypeGraph({ contexts: ['Lending'] }));
    const book = graph.objects.find((object) => object.name === 'Book');
    expect(book?.stub).toBe(true);
    // The contract is the key plus what Lending itself contributes.
    expect(book?.fields.map((field) => field.name).sort()).toEqual(['id', 'onLoan']);
  });

  it('never leaks the owning context’s internal fields or behaviour', () => {
    const graph = library(() => buildTypeGraph({ contexts: ['Lending'] }));
    const sdl = printSDL(graph);
    expect(sdl).not.toContain('title');
    expect(sdl).not.toContain('shelfCode');
    // Behaviour on a stub belongs to the subgraph that owns the type.
    expect(sdl).not.toContain('bookReshelve');
    // A type that is not a boundary never appears at all.
    expect(sdl).not.toContain('type Shelf');
  });

  it('keeps the owning slice complete', () => {
    const graph = library(() => buildTypeGraph({ contexts: ['Catalog'] }));
    const book = graph.objects.find((object) => object.name === 'Book');
    expect(book?.stub).toBeUndefined();
    expect(book?.fields.map((field) => field.name).sort()).toEqual(['id', 'shelfCode', 'title']);
    // Catalog owns the behaviour, so it exposes the mutation.
    expect(graph.mutation?.fields.map((field) => field.name)).toEqual(['bookReshelve']);
    // Lending's contribution stays in Lending.
    expect(book?.fields.some((field) => field.name === 'onLoan')).toBe(false);
  });

  it('reports only the contexts a slice represents, not the ones it depends on', () => {
    const graph = library(() => buildTypeGraph({ contexts: ['Lending'] }));
    expect(graph.contexts).toEqual(['Lending']);
  });

  it('prunes stubs nothing in the slice references', () => {
    const graph = withRegistry((registry) => {
      @BoundedContext('Unused')
      @SemanticType({ boundary: true, key: 'id' })
      class Orphan {
        @Field(() => ID) id!: string;
      }

      @BoundedContext('Main')
      @SemanticType()
      class Thing {
        @Field(() => ID) id!: string;
      }

      @BoundedContext('Main')
      @Portal()
      class MainQuery {
        @Field(() => Thing)
        thing(): Thing {
          return new Thing();
        }
      }

      return buildTypeGraph({ registry, contexts: ['Main'] });
    });

    expect(graph.objects.map((object) => object.name)).toEqual(['Thing']);
  });

  it('can be turned off, which puts the cross-context reference back out of reach', () => {
    expect(() =>
      library(() => buildTypeGraph({ contexts: ['Lending'], boundaryStubs: false })),
    ).toThrow(/outside the selected bounded contexts/);
  });

  it('builds the whole graph unchanged when no slice is requested', () => {
    const graph = library(() => buildTypeGraph());
    const book = graph.objects.find((object) => object.name === 'Book');
    expect(book?.stub).toBeUndefined();
    expect(book?.fields.map((field) => field.name).sort()).toEqual([
      'id',
      'onLoan',
      'shelfCode',
      'title',
    ]);
    expect(graph.contexts).toEqual(['Catalog', 'Lending']);
  });
});

describe('buildContextSubgraphs', () => {
  it('emits one graph per context', () => {
    const subgraphs = library(() => buildContextSubgraphs());
    expect(Object.keys(subgraphs)).toEqual(['Catalog', 'Lending']);
    expect(subgraphs.Catalog?.query.fields.map((f) => f.name)).toEqual(['book', 'shelf']);
    expect(subgraphs.Lending?.query.fields.map((f) => f.name)).toEqual(['loan']);
  });

  it('agrees with the others on the shared boundary type', () => {
    const subgraphs = library(() => buildContextSubgraphs());
    const owned = subgraphs.Catalog?.objects.find((object) => object.name === 'Book');
    const stub = subgraphs.Lending?.objects.find((object) => object.name === 'Book');
    // Same name, same key: that is the whole contract between the two services.
    expect(stub?.key).toBe(owned?.key as string);
    expect(stub?.boundary).toBe(true);
  });
});

describe('subgraphs as SDL artifacts and executable schemas', () => {
  it('prints a federation subgraph per context, with foreign keys marked external', () => {
    const subgraphs = library(() => buildContextSubgraphs());
    const lending = printSDL(subgraphs.Lending!, { federation: true });

    expect(lending).toContain('type Book @key(fields: "id")');
    // Book is owned elsewhere, so Lending declares its key as external.
    expect(lending).toContain('id: ID! @external');
    expect(lending).toContain('onLoan: String!');
    expect(lending).toContain('union _Entity = Book');

    const catalog = printSDL(subgraphs.Catalog!, { federation: true });
    expect(catalog).toContain('type Book @key(fields: "id")');
    // Catalog owns Book, so its key is a real field, not an external reference.
    expect(catalog).toContain('id: ID!\n');
    expect(catalog).not.toContain('@external\n');
  });

  it('executes each subgraph independently', async () => {
    const subgraphs = library(() =>
      buildSemanticSubgraphs({ container: new Container(), federation: true }),
    );

    const catalog = await subgraphs.Catalog?.execute({ query: '{ book { id title } }' });
    expect(catalog.errors).toBeUndefined();
    expect(catalog.data?.book).toEqual({ id: 'b1', title: 'Title b1' });

    const lending = await subgraphs.Lending?.execute({ query: '{ loan { book { id onLoan } } }' });
    expect(lending.errors).toBeUndefined();
    expect((lending.data as any).loan.book).toEqual({ id: 'b1', onLoan: 'b1 is available' });

    // The stub does not expose the owning context's fields.
    const leak = await subgraphs.Lending?.execute({ query: '{ loan { book { title } } }' });
    expect(leak.errors?.[0]?.message).toContain('Cannot query field "title"');
  });

  it('resolves the shared entity by key from the owning subgraph', async () => {
    const subgraphs = library(() =>
      buildSemanticSubgraphs({ container: new Container(), federation: true }),
    );
    const result = await subgraphs.Catalog?.execute({
      query:
        '{ _entities(representations: [{ __typename: "Book", id: "b9" }]) { ... on Book { title } } }',
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any)._entities).toEqual([{ title: 'Title b9' }]);
  });

  it('slices the same way whether one context or several are selected', () => {
    const both = library(() => buildSemanticSchema({ container: new Container() }));
    expect(both.contexts).toEqual(['Catalog', 'Lending']);
    expect(both.graph.objects.some((object) => object.stub)).toBe(false);
  });
});
