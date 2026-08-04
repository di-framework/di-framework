/**
 * Apollo Federation: subgraph SDL generated from ownership boundaries, and
 * `_entities` resolution driven by the same `@Lookup` the domain already
 * declares.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import { BoundedContext, Field, Lookup, Portal, SemanticType } from '../src/decorators.ts';
import { ID } from '../src/scalars.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { withRegistry } from './helpers.ts';

let loaded: string[] = [];

function catalogSubgraph(options: { federation?: boolean } = { federation: true }) {
  return () => {
    @BoundedContext('Catalog')
    @SemanticType({ boundary: true, key: 'id', description: 'A title the library owns.' })
    class Book {
      id!: string;
      title!: string;

      @Field(() => String) author!: string;

      @Field(() => String)
      shelfLabel(): string {
        return `SHELF-${this.id.toUpperCase()}`;
      }

      @Lookup()
      static load(id: string) {
        loaded.push(id);
        return id === 'missing'
          ? null
          : Object.assign(new Book(), { id, title: `Title ${id}`, author: 'Le Guin' });
      }
    }

    // Not a boundary type: internal to Catalog, so never an entity.
    @BoundedContext('Catalog')
    @SemanticType()
    class Shelf {
      @Field(() => ID) code!: string;
    }

    @BoundedContext('Catalog')
    @Portal()
    class CatalogQuery {
      @Field(() => Book)
      book(): Book {
        return Book.load('b1') as Book;
      }

      @Field(() => Shelf)
      shelf(): Shelf {
        return Object.assign(new Shelf(), { code: 'A1' });
      }
    }

    return buildSemanticSchema({ container: new Container(), ...options });
  };
}

describe('federation SDL', () => {
  it('declares the federation link, scalars, _Service and _Entity', () => {
    const api = withRegistry(catalogSubgraph());
    expect(api.sdl).toContain(
      'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3"',
    );
    expect(api.sdl).toContain('scalar _Any');
    expect(api.sdl).toContain('scalar _FieldSet');
    expect(api.sdl).toContain('type _Service {');
    expect(api.sdl).toContain('union _Entity = Book');
  });

  it('turns boundary types into entities and leaves internal types alone', () => {
    const api = withRegistry(catalogSubgraph());
    expect(api.sdl).toContain('type Book @key(fields: "id") {');
    expect(api.sdl).toContain('type Shelf {');
    expect(api.sdl).not.toContain('type Shelf @key');
    // Only the boundary type joins the entity union.
    expect(api.sdl).not.toContain('_Entity = Book | Shelf');
  });

  it('adds the gateway entry points to Query', () => {
    const api = withRegistry(catalogSubgraph());
    expect(api.sdl).toContain('_entities(representations: [_Any!]!): [_Entity]!');
    expect(api.sdl).toContain('_service: _Service!');
  });

  it('emits none of it unless federation is on', () => {
    const api = withRegistry(catalogSubgraph({ federation: false }));
    expect(api.sdl).not.toContain('_Entity');
    expect(api.sdl).not.toContain('@link');
    expect(api.sdl).not.toContain('_service');
  });

  it('keeps ownership directives distinct from federation directives', () => {
    const ownership = withRegistry(() => {
      @BoundedContext('Catalog')
      @SemanticType({ boundary: true, key: 'id' })
      class Book {
        @Field(() => ID) id!: string;
      }

      @BoundedContext('Catalog')
      @Portal()
      class Q {
        @Field(() => Book)
        book(): Book {
          return new Book();
        }
      }

      return buildSemanticSchema({ container: new Container(), print: { directives: true } });
    });

    // Ownership mode documents the context; federation mode does not.
    expect(ownership.sdl).toContain('@context(name: "Catalog")');
    expect(ownership.sdl).not.toContain('@link');
  });
});

describe('_service', () => {
  it('returns this subgraph’s own SDL', async () => {
    const api = withRegistry(catalogSubgraph());
    const result = await api.execute({ query: '{ _service { sdl } }' });
    expect(result.errors).toBeUndefined();
    const sdl = (result.data as any)._service.sdl as string;
    expect(sdl).toContain('type Book @key(fields: "id")');
    expect(sdl).toContain('union _Entity');
  });
});

describe('_entities', () => {
  it('resolves a representation through the type’s @Lookup', async () => {
    loaded = [];
    const api = withRegistry(catalogSubgraph());
    const result = await api.execute({
      query: `{
        _entities(representations: [{ __typename: "Book", id: "b7" }]) {
          __typename
          ... on Book { author shelfLabel }
        }
      }`,
    });
    expect(result.errors).toBeUndefined();
    expect(loaded).toEqual(['b7']);
    // shelfLabel proves the loaded row was hydrated onto Book.
    expect((result.data as any)._entities).toEqual([
      { __typename: 'Book', author: 'Le Guin', shelfLabel: 'SHELF-B7' },
    ]);
  });

  it('resolves several representations in one call', async () => {
    loaded = [];
    const api = withRegistry(catalogSubgraph());
    const result = await api.execute({
      query: `{
        _entities(representations: [
          { __typename: "Book", id: "b1" },
          { __typename: "Book", id: "b2" }
        ]) { ... on Book { author } }
      }`,
    });
    expect(result.errors).toBeUndefined();
    expect(loaded).toEqual(['b1', 'b2']);
    expect((result.data as any)._entities).toHaveLength(2);
  });

  it('returns null for a key the lookup cannot find', async () => {
    const api = withRegistry(catalogSubgraph());
    const result = await api.execute({
      query:
        '{ _entities(representations: [{ __typename: "Book", id: "missing" }]) { __typename } }',
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any)._entities).toEqual([null]);
  });

  it('refuses a type that is not an entity in this subgraph', async () => {
    const api = withRegistry(catalogSubgraph());
    const result = await api.execute({
      query: '{ _entities(representations: [{ __typename: "Shelf", code: "A1" }]) { __typename } }',
    });
    expect(result.errors?.[0]?.message).toContain("'Shelf' is not an entity");
    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_ENTITY');
  });

  it('reports a boundary type that never declared a @Lookup', async () => {
    const api = withRegistry(() => {
      @BoundedContext('Billing')
      @SemanticType({ boundary: true, key: 'id' })
      class Invoice {
        @Field(() => String) total!: string;
      }

      @BoundedContext('Billing')
      @Portal()
      class Q {
        @Field(() => Invoice)
        invoice(): Invoice {
          return new Invoice();
        }
      }

      return buildSemanticSchema({ container: new Container(), federation: true });
    });

    const result = await api.execute({
      query: '{ _entities(representations: [{ __typename: "Invoice", id: "i1" }]) { __typename } }',
    });
    expect(result.errors?.[0]?.message).toContain('has no @Lookup');
  });

  it('is absent from a subgraph with no entities at all', () => {
    const api = withRegistry(() => {
      @SemanticType()
      class Note {
        @Field(() => String) body!: string;
      }

      @Portal()
      class Q {
        @Field(() => Note)
        note(): Note {
          return new Note();
        }
      }

      return buildSemanticSchema({ container: new Container(), federation: true });
    });

    expect(api.sdl).not.toContain('_Entity');
    expect(api.sdl).not.toContain('_entities(');
    // `_service` is still required of every subgraph.
    expect(api.sdl).toContain('_service: _Service!');
  });
});
