/**
 * Relay connections: generated SDL, cursor helpers, the slicing algorithm and
 * how `@Connection` composes with batching and bounded contexts.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import {
  connectionFromArray,
  connectionFromSlice,
  cursorToOffset,
  decodeCursor,
  encodeCursor,
  offsetToCursor,
  toConnection,
} from '../src/connection.ts';
import { Arg, BoundedContext, Connection, Field, Portal, SemanticType } from '../src/decorators.ts';
import { SemanticBoundaryError } from '../src/errors.ts';
import { ID } from '../src/scalars.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

const LETTERS = ['a', 'b', 'c', 'd', 'e'];

/** Read a root field off an execution result without fighting the result types. */
function pick(result: { data?: unknown }, name: string): any {
  return (result.data as Record<string, any>)[name];
}

function catalogSchema(options: { defaultPageSize?: number; maxPageSize?: number } = {}) {
  return () => {
    @SemanticType()
    class Review {
      @Field(() => ID) id!: string;
      @Field(() => String) body!: string;
    }

    @Portal()
    class Query {
      @Connection(() => Review, options)
      reviews(): Review[] {
        return LETTERS.map((letter) => Object.assign(new Review(), { id: letter, body: letter }));
      }

      @Connection(() => Review)
      byAuthor(@Arg('author', () => String) author: string): Review[] {
        return author === 'none'
          ? []
          : LETTERS.map((letter) => Object.assign(new Review(), { id: letter, body: author }));
      }
    }

    return buildSemanticSchema({ container: new Container() });
  };
}

describe('cursor helpers', () => {
  it('round-trips opaque cursors', () => {
    expect(decodeCursor(encodeCursor('abc'))).toBe('abc');
    expect(decodeCursor(encodeCursor(42))).toBe('42');
    // Cursors are opaque base64, not the raw value.
    expect(encodeCursor('abc')).not.toBe('abc');
  });

  it('round-trips array offsets and rejects foreign cursors', () => {
    expect(cursorToOffset(offsetToCursor(7))).toBe(7);
    expect(cursorToOffset(encodeCursor('not-an-offset'))).toBe(-1);
    expect(() => decodeCursor('!!!not base64!!!')).toThrow('Invalid cursor');
  });

  it('survives non-ASCII identifiers', () => {
    expect(decodeCursor(encodeCursor('café-☕'))).toBe('café-☕');
  });
});

describe('connectionFromArray', () => {
  it('returns the whole set with no arguments', () => {
    const result = connectionFromArray(LETTERS);
    expect(result.edges.map((edge) => edge.node)).toEqual(LETTERS);
    expect(result.totalCount).toBe(5);
    expect(result.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: false });
  });

  it('slices with first and reports more pages', () => {
    const result = connectionFromArray(LETTERS, { first: 2 });
    expect(result.edges.map((edge) => edge.node)).toEqual(['a', 'b']);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.hasPreviousPage).toBe(false);
  });

  it('pages forward with after', () => {
    const page1 = connectionFromArray(LETTERS, { first: 2 });
    const page2 = connectionFromArray(LETTERS, { first: 2, after: page1.pageInfo.endCursor });
    expect(page2.edges.map((edge) => edge.node)).toEqual(['c', 'd']);
    expect(page2.pageInfo.hasPreviousPage).toBe(true);
    expect(page2.pageInfo.hasNextPage).toBe(true);

    const page3 = connectionFromArray(LETTERS, { first: 2, after: page2.pageInfo.endCursor });
    expect(page3.edges.map((edge) => edge.node)).toEqual(['e']);
    expect(page3.pageInfo.hasNextPage).toBe(false);
  });

  it('slices from the end with last, and honours before', () => {
    expect(connectionFromArray(LETTERS, { last: 2 }).edges.map((e) => e.node)).toEqual(['d', 'e']);
    expect(
      connectionFromArray(LETTERS, { before: offsetToCursor(2) }).edges.map((e) => e.node),
    ).toEqual(['a', 'b']);
    expect(
      connectionFromArray(LETTERS, { before: offsetToCursor(4), last: 2 }).edges.map((e) => e.node),
    ).toEqual(['c', 'd']);
  });

  it('reports both flags against the whole set, not the paging direction', () => {
    // Middle slice: there is something on each side, and both flags say so —
    // the spec would allow `hasPreviousPage: false` here when only `first` is set.
    const middle = connectionFromArray(LETTERS, { first: 2, after: offsetToCursor(0) });
    expect(middle.edges.map((edge) => edge.node)).toEqual(['b', 'c']);
    expect(middle.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
  });

  it('rejects negative page sizes', () => {
    expect(() => connectionFromArray(LETTERS, { first: -1 })).toThrow('must not be negative');
    expect(() => connectionFromArray(LETTERS, { last: -1 })).toThrow('must not be negative');
  });

  it('handles an empty set', () => {
    const result = connectionFromArray([], { first: 10 });
    expect(result.edges).toEqual([]);
    expect(result.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    });
  });
});

describe('connectionFromSlice', () => {
  it('builds a connection from a page the repository already cut', () => {
    const result = connectionFromSlice(['x', 'y'], {
      cursorFor: (node) => `id:${node}`,
      hasNextPage: true,
      totalCount: 99,
    });
    expect(result.totalCount).toBe(99);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(decodeCursor(result.edges[0]?.cursor)).toBe('id:x');
  });
});

describe('toConnection', () => {
  it('passes through nullish, connection-shaped, array, and other values', () => {
    expect(toConnection(null, {})).toBeNull();
    expect(toConnection(undefined, {})).toBeUndefined();
    const shaped = connectionFromArray(['a']);
    expect(toConnection(shaped, {})).toBe(shaped);
    expect(
      (toConnection(['a', 'b'], { first: 1 }) as { edges: { node: string }[] }).edges.map(
        (e) => e.node,
      ),
    ).toEqual(['a']);
    expect(toConnection(42, {})).toBe(42);
  });
});

describe('@Connection SDL', () => {
  it('generates Relay-shaped connection, edge and PageInfo types', () => {
    const api = withRegistry(catalogSchema());
    expect(api.sdl).toContain('type ReviewConnection {');
    expect(api.sdl).toContain('edges: [ReviewEdge!]!');
    expect(api.sdl).toContain('pageInfo: PageInfo!');
    expect(api.sdl).toContain('type ReviewEdge {');
    expect(api.sdl).toContain('node: Review!');
    expect(api.sdl).toContain('cursor: String!');
    expect(api.sdl).toContain('type PageInfo {');
    expect(api.sdl).toContain('hasNextPage: Boolean!');
    expect(api.sdl).toContain('startCursor: String');
  });

  it('adds the four pagination arguments to the field', () => {
    const api = withRegistry(catalogSchema());
    const field = api.graph.query.fields.find((f) => f.name === 'reviews');
    expect(field?.args.map((arg) => arg.name)).toEqual(['first', 'after', 'last', 'before']);
  });

  it('keeps the field’s own arguments alongside the pagination ones', () => {
    const api = withRegistry(catalogSchema());
    const field = api.graph.query.fields.find((f) => f.name === 'byAuthor');
    expect(field?.args.map((arg) => arg.name)).toEqual([
      'author',
      'first',
      'after',
      'last',
      'before',
    ]);
  });

  it('generates PageInfo exactly once across several connections', () => {
    const api = withRegistry(catalogSchema());
    expect(api.graph.objects.filter((object) => object.name === 'PageInfo')).toHaveLength(1);
    expect(api.graph.objects.filter((object) => object.name === 'ReviewEdge')).toHaveLength(1);
  });
});

describe('@Connection execution', () => {
  it('slices an array returned by the domain method', async () => {
    const api = withRegistry(catalogSchema());
    const result = await api.execute({
      query:
        '{ reviews(first: 2) { totalCount edges { cursor node { id } } pageInfo { hasNextPage endCursor } } }',
    });
    expect(result.errors).toBeUndefined();
    const reviews = pick(result, 'reviews');
    expect(reviews.totalCount).toBe(5);
    expect(reviews.edges.map((edge: any) => edge.node.id)).toEqual(['a', 'b']);
    expect(reviews.pageInfo.hasNextPage).toBe(true);
  });

  it('pages forward using the returned cursor', async () => {
    const api = withRegistry(catalogSchema());
    const first = await api.execute({
      query: '{ reviews(first: 2) { pageInfo { endCursor } } }',
    });
    const cursor = pick(first, 'reviews').pageInfo.endCursor;

    const second = await api.execute({
      query: `{ reviews(first: 2, after: "${cursor}") { edges { node { id } } } }`,
    });
    expect(pick(second, 'reviews').edges.map((e: any) => e.node.id)).toEqual(['c', 'd']);
  });

  it('applies defaultPageSize when the caller asks for no page', async () => {
    const api = withRegistry(catalogSchema({ defaultPageSize: 2 }));
    const result = await api.execute({ query: '{ reviews { edges { node { id } } } }' });
    expect(pick(result, 'reviews').edges).toHaveLength(2);
  });

  it('rejects a page larger than maxPageSize', async () => {
    const api = withRegistry(catalogSchema({ maxPageSize: 3 }));
    const result = await api.execute({ query: '{ reviews(first: 50) { totalCount } }' });
    expect(result.errors?.[0]?.message).toContain('exceeds the maximum of 3');
  });

  it('passes through a connection the domain built itself', async () => {
    const api = withRegistry(() => {
      @SemanticType()
      class Item {
        @Field(() => ID) id!: string;
      }

      @Portal()
      class Query {
        // The repository pages natively, so the field returns a finished slice.
        @Connection(() => Item)
        items(): any {
          return connectionFromSlice([Object.assign(new Item(), { id: 'z' })], {
            cursorFor: (node: any) => node.id,
            hasNextPage: true,
            totalCount: 500,
          });
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({
      query: '{ items(first: 1) { totalCount edges { node { id } } pageInfo { hasNextPage } } }',
    });
    const items = pick(result, 'items');
    expect(items.totalCount).toBe(500);
    expect(items.edges.map((edge: any) => edge.node.id)).toEqual(['z']);
    expect(items.pageInfo.hasNextPage).toBe(true);
  });

  it('works on a semantic type field with batching', async () => {
    let batches = 0;
    const api = withRegistry(() => {
      @SemanticType()
      class Comment {
        @Field(() => ID) id!: string;
      }

      @SemanticType({ key: 'id' })
      class Post {
        id!: string;

        @Field(() => ID) title!: string;

        @Connection(() => Comment, { batch: 'commentsFor' })
        comments(): Comment[] {
          return [];
        }

        static commentsFor(posts: Post[]): Comment[][] {
          batches += 1;
          return posts.map((post) => [Object.assign(new Comment(), { id: `${post.id}-c1` })]);
        }
      }

      @Portal()
      class Query {
        @Field(() => [Post])
        posts(): Post[] {
          return ['p1', 'p2'].map((id) => Object.assign(new Post(), { id, title: id }));
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const result = await api.execute({
      query: '{ posts { title comments(first: 1) { edges { node { id } } } } }',
      context: {},
    });
    expect(result.errors).toBeUndefined();
    const posts = pick(result, 'posts') as any[];
    expect(posts.map((post) => post.comments.edges[0].node.id)).toEqual(['p1-c1', 'p2-c1']);
    // Both parents were coalesced into a single batch call.
    expect(batches).toBe(1);
  });
});

describe('@Connection and bounded contexts', () => {
  it('rejects paginating another context’s non-boundary type', () => {
    expect(() =>
      withRegistry((registry) => {
        @BoundedContext('Reviews')
        @SemanticType()
        class Review {
          @Field(() => ID) id!: string;
        }

        @BoundedContext('Catalog')
        @Portal()
        class CatalogQuery {
          @Connection(() => Review)
          reviews(): Review[] {
            return [];
          }
        }

        return buildTypeGraph({ registry });
      }),
    ).toThrow(SemanticBoundaryError);
  });

  it('allows paginating a boundary type across contexts', () => {
    const graph = withRegistry((registry) => {
      @BoundedContext('Reviews')
      @SemanticType({ boundary: true, key: 'id' })
      class Review {
        @Field(() => ID) id!: string;
      }

      @BoundedContext('Catalog')
      @Portal()
      class CatalogQuery {
        @Connection(() => Review)
        reviews(): Review[] {
          return [];
        }
      }

      return buildTypeGraph({ registry });
    });

    expect(graph.objects.map((object) => object.name)).toEqual(
      expect.arrayContaining(['ReviewConnection', 'ReviewEdge', 'PageInfo']),
    );
  });
});
