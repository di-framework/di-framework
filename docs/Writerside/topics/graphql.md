# GraphQL

Object-oriented, decorator-driven GraphQL for `@di-framework/core`. Your domain classes **are** the schema — there is no SDL document to keep in sync, no resolver map, and no field-by-field mapping layer. Decorators declare semantic exposure (`@Field`, `@Action`), ownership (`@BoundedContext`), and boundaries (`@SemanticType({ boundary: true })`), and the schema falls out of that.

## Features

- **Objects, not resolvers**: Behaviour lives on the class that owns the invariant. `@Action` on an entity becomes a root mutation that loads the entity first.
- **Bounded contexts enforced**: Cross-context references require explicit boundary types. Violations fail at build time.
- **Extend across the seam**: `@Extends` lets one context contribute fields to another's boundary type.
- **Hydration**: Plain repository rows are re-hydrated onto their class before resolution, so method fields keep working.
- **Built-in batching**: `@Field({ batch })` coalesces work across parents in the same tick — no DataLoader dependency.
- **Subscriptions from the container**: Pair with core `@Publisher`; the service never learns GraphQL exists.
- **SDL as an artifact**: Print portable SDL from `@di-framework/graphql/core` without importing `graphql`.
- **DI throughout**: Portals and extensions are container-managed like any other component.

## Installation

```bash
bun add @di-framework/graphql @di-framework/core graphql
# or
npm install @di-framework/graphql @di-framework/core graphql
```

`graphql` is an optional peer dependency: you only need it to execute queries. Importing from `@di-framework/graphql/core` (decorators, registry, type graph, SDL printer) works without it.

Decorators need TypeScript 5 and `experimentalDecorators`. `emitDecoratorMetadata` is not required — types are declared with runtime markers.

## Quick Start

```typescript
import { Component, Container } from '@di-framework/core/decorators';
import {
  Arg,
  Field,
  ID,
  Portal,
  SemanticType,
  buildSemanticSchema,
  createGraphQLHandler,
} from '@di-framework/graphql';

interface BookRow {
  id: string;
  title: string;
  author: string;
}

@Container()
class BookRepository {
  private rows: BookRow[] = [{ id: 'b1', title: 'Ariel', author: 'Sylvia Plath' }];

  find(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

@SemanticType({ key: 'id', expose: { title: () => String, author: () => String } })
class Book {
  constructor(
    public id: string,
    public title: string,
    public author: string,
  ) {}

  @Field(() => String)
  shelfLabel(): string {
    return `${this.author.split(' ').pop()}-${this.id}`.toUpperCase();
  }
}

@Portal()
class CatalogPortal {
  constructor(@Component(BookRepository) private repo: BookRepository) {}

  @Field(() => Book, { nullable: true })
  book(@Arg('id', () => ID) id: string) {
    return this.repo.find(id);
  }
}

const api = buildSemanticSchema();

const result = await api.execute({
  query: '{ book(id: "b1") { title shelfLabel } }',
});
// { data: { book: { title: 'Ariel', shelfLabel: 'PLATH-B1' } } }

const handler = createGraphQLHandler(api);
```

`api.sdl` is the schema as SDL, `api.schema` is an executable `graphql-js` schema, and `api.graph` is the resolved semantic graph you can assert against.

## Core Concepts

### Semantic types

`@SemanticType` declares a class as a type in the schema. Use `expose` for constructor parameter properties (which cannot carry their own decorators). A type with a `key` always exposes it; `boundary: true` requires a `key` so other contexts can re-identify the object.

```typescript
@SemanticType({
  key: 'id',
  boundary: true,
  expose: {
    title: () => String,
    copies: { type: () => Int, description: 'Copies owned.' },
  },
})
class Book {
  constructor(
    public id: string,
    public title: string,
    public copies: number,
  ) {}
}
```

### Portals

A portal is a root object registered with the DI container:

- `@Field` → Query fields
- `@Action` → Mutation fields
- `@Subscription` → Subscription fields

```typescript
@Portal({ singleton: true })
class CatalogPortal {
  constructor(@Component(BookRepository) private repo: BookRepository) {}

  @Field(() => [Book])
  books(@Arg('limit', () => Int, { nullable: true, defaultValue: 10 }) limit: number) {
    return this.repo.findAll(limit);
  }

  @Action(() => Book)
  addBook(@Arg('input', () => BookInput) input: BookInput) {
    return this.repo.create(input);
  }
}
```

Portals cannot be used as field types. If no portal declares a query field, the schema synthesizes `_contexts: [String!]!` so it stays valid.

### Entity actions

An `@Action` on a semantic type (not a portal) becomes a root mutation named `<type><Method>`, with an implicit key argument. The entity is loaded through `@Lookup` before the method runs.

```typescript
@SemanticType({ boundary: true, key: 'id' })
class Loan {
  @Lookup()
  static load(id: string) {
    return useContainer().resolve(LoanService).find(id);
  }

  @Action({ description: 'Give the book back.' })
  checkIn(): void {
    if (this.state !== 'Active') throw new Error(`Loan ${this.id} was already returned.`);
    this.state = 'Returned';
  }
}
```

That yields `loanCheckIn(id: ID!): Loan!`.

### Bounded contexts and boundaries

`@BoundedContext('Name')` records who owns a class. By default (`enforceBoundaries: true`) a context may only reference or extend another context's types when those types declare `boundary: true` — otherwise `SemanticBoundaryError` is thrown at build time.

```typescript
@BoundedContext('Reviews')
@SemanticType() // internal; no other context may point at it
class Review {
  /* … */
}
```

Build a subset of contexts for a deployment seam:

```typescript
const publicApi = buildSemanticSchema({ contexts: ['Catalog', 'Reviews'] });
```

### Extending another context's type

`@Extends` contributes fields to a boundary type owned elsewhere. The extension class is DI-managed and receives the parent through `@Parent()`.

```typescript
@BoundedContext('Reviews')
@Extends(() => Book)
class BookReviews {
  constructor(@Component(ReviewRepository) private repo: ReviewRepository) {}

  @Field(() => [Review], { batch: 'reviewsForBooks' })
  reviews(@Parent() book: BookRow) {
    return this.repo.forBook(book.id);
  }

  reviewsForBooks(books: BookRow[]) {
    return this.repo.forBooks(books.map((book) => book.id));
  }
}
```

### Batching

`@Field({ batch })` takes:

| Value | Meaning |
| --- | --- |
| `true` | De-duplicate and memoize per (parent, args) for the request. |
| `'methodName'` | Method with signature `(parents, args[], ctx) => R[]`. Results matched by index. |
| function | Same signature, inline. |

Batching is request-scoped; pass a fresh context per request (`execute()` defaults to `{}`).

### Input objects

`@InputType` classes are rebuilt from the plain values GraphQL hands the resolver, so their methods are callable. An input type must declare at least one `@Field`.

```typescript
@InputType()
class ReviewInput {
  @Field(() => Int) rating!: number;

  clampedRating() {
    return Math.min(5, Math.max(1, this.rating));
  }
}
```

### Subscriptions

`@Subscription` reads the container's event bus (what core `@Publisher` writes to). Subscriptions may only be declared on portals.

```typescript
@Container()
class LoanService {
  @Publisher('loan.checkedOut')
  checkOut(bookId: string, memberId: string): LoanRow {
    /* … */
  }
}

@Portal()
class LendingPortal {
  @Subscription('loan.checkedOut', () => Loan, {
    filter: (payload, args) => !args.memberId || payload?.result?.memberId === args.memberId,
  })
  loanCheckedOut(
    @Parent() loan: LoanRow,
    @Arg('memberId', () => ID, { nullable: true }) memberId: string | null,
  ) {
    return loan;
  }
}
```

Use `api.subscribe(...)` to get an `AsyncIterableIterator` of results.

### Enums and scalars

Types are runtime markers — no `reflect-metadata`:

```typescript
import { Bool, DateTime, Float, ID, Int, Json, Str, registerEnum } from '@di-framework/graphql';

export const Genre = { Fiction: 'Fiction', Poetry: 'Poetry' } as const;
registerEnum(Genre, { name: 'Genre' });

@Field(() => ID) id!: string;
@Field(() => [Book]) books!: Book[];
@Field(() => Genre) genre!: string;
```

`String`, `Number`, `Boolean`, and `Date` also work and map to `String`, `Float`, `Boolean`, and `DateTime`.

### Request context

| Decorator | Injects |
| --- | --- |
| `@Ctx()` | Per-request context |
| `@Parent()` | Parent object (`@Extends`, subscriptions) |
| `@Info()` | GraphQL resolve info |
| `@Arg(...)` | GraphQL argument |

An undecorated parameter named `ctx`, `context`, `_ctx`, or `_context` is treated as the context; one named `info` as resolve info.

## Building and Serving

```typescript
const api = buildSemanticSchema({
  container, // defaults to useContainer()
  registry, // defaults to the global SemanticRegistry
  contexts: ['Catalog'], // restrict to these bounded contexts
  enforceBoundaries: true,
  strictTypes: false, // reject undeclared types instead of assuming String
  print: { directives: true, descriptions: true },
});
```

| Member | Purpose |
| --- | --- |
| `graph` | Resolved, validated semantic graph |
| `schema` | Executable `graphql-js` schema |
| `sdl` | Same graph as SDL |
| `execute({ query, variables, operationName, context })` | Run a query/mutation |
| `subscribe({ … })` | Async iterable of subscription results |

```typescript
import { createGraphQLHandler } from '@di-framework/graphql';

export const handler = createGraphQLHandler(api, {
  context: (request) => ({ memberId: request.headers.get('x-member-id') }),
});

Bun.serve({ port: 4000, fetch: handler });
```

`GET` reads `query` / `variables` / `operationName` from the query string, `POST` from a JSON body. Subscriptions need a connection — drive `api.subscribe()` from your own WebSocket or SSE endpoint.

## SDL as a Build Artifact

`@di-framework/graphql/core` never imports `graphql`, so emitting the schema is cheap enough for CI:

```typescript
import { buildTypeGraph, printSDL } from '@di-framework/graphql/core';

const graph = buildTypeGraph({ strictTypes: true });
await Bun.write('schema.graphql', printSDL(graph, { directives: true }));
```

With `directives: true`, ownership is recorded (`@key`, `@context`), which makes the artifact worth diffing in review. `buildTypeGraph()` also throws if a context has reached somewhere it should not.

## Apollo Federation

A boundary type already declares the two things federation needs from an entity: a `key` that identifies it, and a `@Lookup` that turns that key back into an object. Turning a schema into a subgraph is therefore a flag, not a second set of annotations:

```typescript
const catalog = buildSemanticSchema({ contexts: ['Catalog'], federation: true });
```

That adds `_entities(representations: [_Any!]!)` and `_service { sdl }` to `Query`, prints the federation `@link` header, declares `_Any`/`_FieldSet`/`_Service`/`_Entity`, and gives every boundary type a real `@key`. `_entities` resolves each representation through that type's `@Lookup` and hydrates the result, so the entity's own methods work on the way back out.

### Two directive modes, deliberately separate

`print.directives` and `federation` both describe ownership, but they are not the same output and should not be mixed up:

| | `print: { directives: true }` | `federation: true` |
|---|---|---|
| Audience | humans, in review | an Apollo gateway |
| Vocabulary | this package's `@key` / `@context` | Apollo Federation v2 |
| Declares `@context` | yes — which context owns each type and field | no; federation has no such concept |
| Adds `_entities` / `_service` | no | yes |
| Portable SDL | yes, once the two directives are declared | only to a federation-aware gateway |

Reach for `directives` when the artifact exists so a reviewer can see a boundary move. Reach for `federation` when a gateway is going to compose the result.

Types this subgraph does not own are printed as stubs: the key field only, marked `@external`, plus whatever this subgraph contributes via `@Extends`.

## API Surface

**Type decorators** — `@SemanticType`, `@Portal`, `@InputType`, `@BoundedContext`, `@Extends`, `registerEnum`

**Member decorators** — `@Field`, `@Action`, `@Subscription`, `@Lookup` (static)

**Parameter decorators** — `@Arg`, `@Ctx`, `@Parent`, `@Info`

**Scalars** — `ID`, `Int`, `Float`, `Str`, `Bool`, `DateTime`, `Json`

**Schema** — `buildSemanticSchema`, `createGraphQLHandler`

**Core (no `graphql`)** — `buildTypeGraph`, `printSDL`, `SemanticRegistry`, `getRegistry`, `setRegistry`, `SemanticSchemaError`, `SemanticBoundaryError`

Fields and list items are non-null by default. A bare `@Field()` is assumed to be `String` unless you build with `strictTypes: true`.

## Common Pitfalls

- **Types are runtime markers.** Use `@Field(() => Int)`, never a TypeScript annotation alone.
- **Pass argument names explicitly.** `@Arg('id', () => ID)` — names are parsed from the source and minification can rename them.
- **Decorators write to the current registry at import time.** Use `setRegistry()` / `buildSemanticSchema({ registry })` when a process builds more than one schema (e.g. tests).
- **Enums and classes are referenced through thunks.** `() => Genre`, not `Genre`.

## Example

A three-context worked example — batching, boundaries, entity actions, subscriptions, and GraphiQL — lives in the [graphql example package](https://github.com/di-framework/di-framework/tree/main/examples/packages/graphql).
