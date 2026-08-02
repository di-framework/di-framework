/**
 * Catalog — the bounded context that owns titles.
 *
 * Everything the outside world knows about a book is declared here, on the
 * class that owns it. Other contexts (Reviews, Lending) may reference and
 * extend `Book` because it is a *boundary type*; they may not reach past it.
 */

import { useContainer } from '@di-framework/core';
import { Component, Container } from '@di-framework/core/decorators';
import {
  Action,
  Arg,
  BoundedContext,
  Ctx,
  DateTime,
  Field,
  ID,
  Info,
  InputType,
  Int,
  Json,
  Lookup,
  Portal,
  registerEnum,
  SemanticType,
} from '@di-framework/graphql';
import type { GraphQLResolveInfo } from 'graphql';
// Must be evaluated before the first decorated class below. See registry.ts.
import './registry.ts';
import { type LibraryContext, requireLibrarian } from './context.ts';

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A plain object becomes a GraphQL enum. Reference it from decorators through a
 * thunk — `() => Genre` — the same way you reference a class.
 */
export const Genre = {
  Fiction: 'Fiction',
  NonFiction: 'NonFiction',
  Poetry: 'Poetry',
  Reference: 'Reference',
} as const;

registerEnum(Genre, { name: 'Genre', description: 'How the shelves are organised.' });

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/** What the storage layer hands back: structurally correct, behaviour-free. */
export interface BookRow {
  id: string;
  title: string;
  author: string;
  genre: string;
  publishedAt: Date;
  copies: number;
  metadata: Record<string, unknown> | null;
}

@Container()
export class BookRepository {
  /** Bumped on every read, so tests can prove the batching actually batches. */
  reads = 0;

  private readonly rows: BookRow[] = [
    {
      id: 'b1',
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      genre: Genre.Fiction,
      publishedAt: new Date('1969-03-01T00:00:00.000Z'),
      copies: 4,
      metadata: { awards: ['Hugo', 'Nebula'] },
    },
    {
      id: 'b2',
      title: 'Structure and Interpretation of Computer Programs',
      author: 'Harold Abelson',
      genre: Genre.Reference,
      publishedAt: new Date('1985-07-25T00:00:00.000Z'),
      copies: 2,
      metadata: { edition: 2 },
    },
    {
      id: 'b3',
      title: 'Ariel',
      author: 'Sylvia Plath',
      genre: Genre.Poetry,
      publishedAt: new Date('1965-01-01T00:00:00.000Z'),
      copies: 1,
      metadata: null,
    },
  ];

  find(id: string): BookRow | null {
    this.reads++;
    return this.rows.find((row) => row.id === id) ?? null;
  }

  all(genre?: string | null): BookRow[] {
    this.reads++;
    return genre ? this.rows.filter((row) => row.genre === genre) : [...this.rows];
  }

  add(row: BookRow): BookRow {
    this.rows.push(row);
    return row;
  }
}

/** Somewhere to record what `@Info()` observed, so a test can assert on it. */
@Container()
export class QueryStats {
  readonly selections: Array<{ field: string; count: number }> = [];

  record(info: GraphQLResolveInfo): void {
    const node = info.fieldNodes[0];
    this.selections.push({
      field: info.fieldName,
      count: node?.selectionSet?.selections.length ?? 0,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The semantic type                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `expose` publishes constructor parameter properties, which cannot carry
 * decorators of their own. The key (`id`) is always exposed — a boundary type
 * has to be re-identifiable from the other side of the boundary.
 */
@BoundedContext('Catalog')
@SemanticType({
  boundary: true,
  key: 'id',
  description: 'A title the library owns copies of.',
  expose: {
    title: () => String,
    author: () => String,
    genre: () => Genre,
    publishedAt: () => DateTime,
    copies: { type: () => Int, description: 'Copies the library owns, on the shelf or not.' },
    metadata: {
      type: () => Json,
      nullable: true,
      description: 'Unmodelled extras. An escape hatch — prefer real fields.',
    },
  },
})
export class Book {
  constructor(
    public id: string,
    public title: string,
    public author: string,
    public genre: string,
    public publishedAt: Date,
    public copies: number,
    public metadata: Record<string, unknown> | null,
  ) {}

  /**
   * How another context turns a stored `bookId` back into a `Book` — see
   * `Loan.book()` in the Lending context. Also what `@Action`s declared on this
   * class would use to load the entity before invoking behaviour.
   */
  @Lookup()
  static load(id: string): BookRow | null {
    return useContainer().resolve(BookRepository).find(id);
  }

  /**
   * A derived field. Rows from the repository are hydrated onto this class
   * before resolution, so plain data gets the behaviour of its type.
   */
  @Field(() => String, { description: 'Where to find it on the shelf.' })
  shelfLabel(): string {
    const surname = this.author.split(' ').pop() ?? this.author;
    return `${this.genre.slice(0, 3).toUpperCase()}-${surname.slice(0, 4).toUpperCase()}-${this.id}`;
  }

  @Field(() => Int, { description: 'Years since publication.' })
  age(): number {
    const published = this.publishedAt.getUTCFullYear();
    return new Date().getUTCFullYear() - published;
  }
}

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Input objects are classes too. GraphQL hands resolvers plain objects; this
 * package rebuilds them onto the `@InputType` class, so `slug()` below is
 * callable from the service that receives it.
 */
@InputType({ description: 'A title to add to the catalog.' })
export class BookInput {
  @Field(() => String)
  title!: string;

  @Field(() => String)
  author!: string;

  @Field(() => Genre)
  genre!: string;

  @Field(() => DateTime)
  publishedAt!: Date;

  @Field(() => Int, { nullable: true })
  copies?: number;

  /** Only callable because the input was hydrated onto this class. */
  slug(): string {
    return this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 24);
  }
}

/* -------------------------------------------------------------------------- */
/* Portal                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A portal is a root object: its `@Field`s become `Query` fields and its
 * `@Action`s become `Mutation` fields. Portals are DI-managed, so they take
 * their collaborators through the constructor like any other component.
 */
@BoundedContext('Catalog')
@Portal({ singleton: true })
export class CatalogPortal {
  constructor(
    @Component(BookRepository) private readonly repo: BookRepository,
    @Component(QueryStats) private readonly stats: QueryStats,
  ) {}

  @Field(() => Book, { nullable: true, description: 'One title, by id.' })
  book(@Arg('id', () => ID) id: string): BookRow | null {
    return this.repo.find(id);
  }

  /**
   * `@Info()` injects the GraphQL resolve info — useful for tracing, cost
   * analysis or deciding how much to prefetch.
   */
  @Field(() => [Book], { description: 'Every title, optionally filtered by genre.' })
  books(
    @Arg('genre', () => Genre, { nullable: true }) genre: string | null,
    @Arg('limit', () => Int, { nullable: true, defaultValue: 10 }) limit: number | null,
    @Info() info: GraphQLResolveInfo,
  ): BookRow[] {
    this.stats.record(info);
    return this.repo.all(genre).slice(0, limit ?? 10);
  }

  /**
   * An action on a portal is a plain root mutation. Authorization is a domain
   * decision, so it is expressed here rather than in transport middleware.
   */
  @Action(() => Book, { description: 'Acquire a new title.' })
  addBook(@Arg('input', () => BookInput) input: BookInput, @Ctx() ctx: LibraryContext): BookRow {
    requireLibrarian(ctx);
    return this.repo.add({
      id: input.slug(),
      title: input.title,
      author: input.author,
      genre: input.genre,
      publishedAt: input.publishedAt,
      copies: input.copies ?? 1,
      metadata: null,
    });
  }
}
