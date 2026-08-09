# @di-framework/graphql

Radically object-oriented, decorator-driven GraphQL for [di-framework](https://github.com/di-framework/di-framework).

Your domain classes **are** the schema. There is no SDL document to keep in sync, no resolver map, and no field-by-field mapping layer — decorators declare semantic *exposure* (`@Field`, `@Action`), *ownership* (`@BoundedContext`) and *boundaries* (`@SemanticType({ boundary: true })`), and the schema falls out of that.

**Style:** `@Lookup` loaders must be **static**; `@Field` / `@Action` stay **instance** methods on domain objects. Pure schema helpers may be free functions. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).

## Features

- **Objects, not resolvers**: behaviour lives on the class that owns the invariant. `@Action` on an entity becomes a root mutation that loads the entity first, so the rule cannot be routed around.
- **Bounded contexts are enforced**: a context may only reference or extend another context's types when those types are explicitly declared as boundary types. Violations fail the build, not code review.
- **Extend across the seam**: `@Extends` lets one context contribute fields to another's boundary type without either knowing about the other.
- **Hydration**: repository rows, HTTP payloads and JSON columns are plain data; they are re-hydrated onto their class before resolution, so `@Field` methods and invariants keep working.
- **Batching built in**: `@Field({ batch })` coalesces a field across every parent resolved in the same tick. No DataLoader dependency.
- **Subscriptions from the container**: pair with the core `@Publisher` decorator and whatever a service publishes becomes subscribable over GraphQL. The service never learns GraphQL exists.
- **SDL as an artifact**: print portable SDL — with optional `@key` / `@context` ownership directives — without importing `graphql` at all.
- **DI all the way down**: portals and extensions are container-managed, so they take collaborators through the constructor like any other component.
- **No `reflect-metadata`**: types are declared with small runtime markers, matching the core container.

## Installation

```bash
bun add @di-framework/graphql @di-framework/core graphql
# or
npm install @di-framework/graphql @di-framework/core graphql
```

`graphql` is an optional peer dependency: you only need it to execute queries. Importing from `@di-framework/graphql/core` — decorators, the registry, the type graph and the SDL printer — works without it, which keeps schema emission and architecture tests cheap.

Decorators need TypeScript 5 and:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": false // not needed — nothing is inferred from types
  }
}
```

## Quick start

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

// A domain object. `expose` publishes constructor parameter properties, which
// cannot carry decorators of their own.
@SemanticType({ key: 'id', expose: { title: () => String, author: () => String } })
class Book {
  constructor(
    public id: string,
    public title: string,
    public author: string,
  ) {}

  // Derived state stays on the object. Rows are hydrated onto this class before
  // resolution, so this runs even though the repository returns plain data.
  @Field(() => String)
  shelfLabel(): string {
    return `${this.author.split(' ').pop()}-${this.id}`.toUpperCase();
  }
}

// A portal is a root object: its @Fields become Query fields.
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

// A plain Request -> Response function: Bun.serve, a Worker, anything.
const handler = createGraphQLHandler(api);

// Or mount both GET and POST on a Fetch-compatible typed router:
mountGraphQL(router, api, { path: '/graphql' });
```

`api.sdl` holds the schema as SDL, `api.schema` is an executable `graphql-js` schema, and `api.graph` is the resolved semantic graph you can assert against.

## Core concepts

### Semantic types

`@SemanticType` declares a class as a type in the schema.

```typescript
@SemanticType({
  name: 'Book',           // defaults to the class name
  description: '…',
  key: 'id',              // the property holding identity
  keyType: () => ID,      // defaults to ID
  boundary: true,         // other contexts may reference and extend it
  expose: {               // constructor parameter properties, as fields
    title: () => String,
    copies: { type: () => Int, description: 'Copies owned.' },
  },
})
```

A type with a `key` always exposes it. `boundary: true` requires a `key` — the whole point is that the object can be re-identified from the other side.

### Portals

A portal is a root object, registered with the DI container:

- its `@Field`s become `Query` fields,
- its `@Action`s become `Mutation` fields,
- its `@Subscription`s become `Subscription` fields.

```typescript
@Portal({ singleton: true })
class CatalogPortal {
  constructor(@Component(BookRepository) private repo: BookRepository) {}

  @Field(() => [Book])
  books(@Arg('limit', () => Int, { nullable: true, defaultValue: 10 }) limit: number) { … }

  @Action(() => Book)
  addBook(@Arg('input', () => BookInput) input: BookInput, @Ctx() ctx: MyContext) { … }
}
```

Portals cannot be used as field types. If no portal declares a query field, the schema gets a synthesized `_contexts: [String!]!` so it stays valid.

### Behaviour on the object that owns it

An `@Action` declared on a semantic type — rather than a portal — becomes a root mutation named `<type><Method>`, with an implicit key argument. The entity is loaded through the type's `@Lookup` before the method runs, so the invariant never leaves the object.

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

That yields `loanCheckIn(id: ID!): Loan!`. A method that declares no return type resolves to the entity itself; declare one (`@Action(() => Receipt)`) to return something else. `keyArg` renames the implicit argument.

### Bounded contexts and boundaries

`@BoundedContext('Name')` records who owns a class. By default (`enforceBoundaries: true`) a context may only reference or extend types owned by another context when those types declare `boundary: true` — anything else throws `SemanticBoundaryError` at build time.

```typescript
@BoundedContext('Reviews')
@SemanticType() // internal to Reviews; no other context may point at it
class Review { … }
```

Build a subset of contexts to get a smaller schema out of the same domain — a real deployment seam:

```typescript
const publicApi = buildSemanticSchema({ contexts: ['Catalog', 'Reviews'] });
```

Types, portals and extensions belonging to excluded contexts simply are not there.

### Extending another context's type

`@Extends` contributes fields to a boundary type owned by somebody else. The extension class is DI-managed and receives the parent through `@Parent()`.

```typescript
@BoundedContext('Reviews')
@Extends(() => Book)
class BookReviews {
  constructor(@Component(ReviewRepository) private repo: ReviewRepository) {}

  @Field(() => [Review], { batch: 'reviewsForBooks' })
  reviews(@Parent() book: BookRow) {
    return this.repo.forBook(book.id);
  }

  // One call for every Book resolved in the same tick, results matched by index.
  reviewsForBooks(books: BookRow[]) {
    return this.repo.forBooks(books.map((book) => book.id));
  }
}
```

`Book` now has a `reviews` field and Catalog never learns that reviews exist. An extension may not redefine a field that already exists.

### Batching

`@Field({ batch })` takes:

| Value | Meaning |
| --- | --- |
| `true` | De-duplicate and memoize per (parent, args) for the request. Removes repeated work, not the N+1. |
| `'methodName'` | A method on the owning class with the signature `(parents, args[], ctx) => R[]`. Real batching; results are matched back by index. |
| function | The same signature, inline. |

Batching is request-scoped: state is keyed on the context object, so pass a fresh one per request (`execute()` defaults to `{}`).

### Input objects

`@InputType` classes are rebuilt from the plain values GraphQL hands the resolver, so their methods are callable:

```typescript
@InputType()
class ReviewInput {
  @Field(() => Int) rating!: number;

  clampedRating() {
    return Math.min(5, Math.max(1, this.rating));
  }
}
```

An input type must declare at least one `@Field`.

### Subscriptions

`@Subscription` reads the container's event bus, which is what the core `@Publisher` decorator writes to. Subscriptions may only be declared on portals.

```typescript
@Container()
class LoanService {
  @Publisher('loan.checkedOut')
  checkOut(bookId: string, memberId: string): LoanRow { … }
}

@Portal()
class LendingPortal {
  @Subscription('loan.checkedOut', () => Loan, {
    // `filter` sees the raw @Publisher envelope: { className, methodName, args, result }
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

`map` reshapes the payload; without it the publisher envelope is unwrapped to its `result`. Use `api.subscribe(...)` to get an `AsyncIterableIterator` of results.

### Enums and scalars

TypeScript types are erased and this package deliberately avoids `reflect-metadata`, so types are named with runtime markers.

```typescript
import { Bool, DateTime, Float, ID, Int, Json, Str, registerEnum } from '@di-framework/graphql';

export const Genre = { Fiction: 'Fiction', Poetry: 'Poetry' } as const;
registerEnum(Genre, { name: 'Genre' });

@Field(() => ID) id!: string;
@Field(() => [Book]) books!: Book[];        // a one-element array is a list
@Field(() => Genre) genre!: string;          // enums are referenced by thunk, like classes
```

`String`, `Number`, `Boolean` and `Date` also work and map to `String`, `Float`, `Boolean` and `DateTime`. `DateTime` and `JSON` are emitted into the schema only when used.

### The request context

| Decorator | Injects |
| --- | --- |
| `@Ctx()` | the per-request context |
| `@Parent()` | the parent object (used by `@Extends` classes and subscriptions) |
| `@Info()` | the GraphQL resolve info |
| `@Arg(...)` | a GraphQL argument |

An undecorated parameter named `ctx`, `context`, `_ctx` or `_context` is treated as the context, and one named `info` as the resolve info.

## Building the schema

```typescript
const api = buildSemanticSchema({
  container,             // DI container. Defaults to useContainer()
  registry,              // SemanticRegistry to read. Defaults to the global one
  contexts: ['Catalog'], // restrict to these bounded contexts. Defaults to all
  enforceBoundaries: true, // default. Turn off only while migrating
  strictTypes: false,    // reject fields/args with no declared type instead of assuming String
  print: { directives: true, descriptions: true }, // options for `api.sdl`
});
```

Returns:

| Member | |
| --- | --- |
| `graph` | the resolved, validated semantic graph |
| `schema` | executable `graphql-js` schema |
| `sdl` | the same graph as SDL |
| `contexts` | bounded contexts represented in the schema |
| `execute({ query, variables, operationName, context, rootValue })` | → `Promise<ExecutionResult>` |
| `subscribe({ … })` | → `Promise<AsyncIterableIterator<ExecutionResult> \| ExecutionResult>` |

Both validate the document first and return errors without executing.

## Serving it

```typescript
import { createGraphQLHandler } from '@di-framework/graphql';

export const handler = createGraphQLHandler(api, {
  context: (request) => ({ memberId: request.headers.get('x-member-id') }),
});

Bun.serve({ port: 4000, fetch: handler });
```

`GET` reads `query` / `variables` / `operationName` from the query string, `POST` from a JSON body; anything else is a 405, and a document that fails validation is a 400. Subscriptions need a connection rather than a request — drive `api.subscribe()` from your own WebSocket or SSE endpoint (the example below ships a ~60-line `graphql-transport-ws` implementation).

## SDL as a build artifact

`@di-framework/graphql/core` never imports `graphql`, so emitting the schema and asserting on its shape is cheap enough to run on every commit.

```typescript
import { buildTypeGraph, printSDL } from '@di-framework/graphql/core';

const graph = buildTypeGraph({ strictTypes: true });

await Bun.write('schema.graphql', printSDL(graph, { directives: true }));
```

With `directives: true` the output records ownership, which makes it worth diffing in review:

```graphql
type Book @key(fields: "id") @context(name: "Catalog") {
  title: String! @context(name: "Catalog")
  reviews: [Review!]! @context(name: "Reviews")
}
```

The same call is a useful architecture test — `buildTypeGraph()` throws if any context has reached somewhere it should not.

## API reference

**Type decorators** — `@SemanticType(options?)`, `@Portal(options?)`, `@InputType(options?)`, `@BoundedContext(name)`, `@Extends(() => Type, options?)`, `registerEnum(object, { name, description? })`

**Member decorators** — `@Field(type?, options?)`, `@Action(type?, options?)`, `@Subscription(event, type?, options?)`, `@Lookup()` (static)

**Parameter decorators** — `@Arg(name?, type?, options?)`, `@Ctx()`, `@Parent()`, `@Info()`

**Field options** — `name`, `description`, `type`, `nullable`, `nullableItems`, `args`, `deprecated`, `batch`. Fields and list items are non-null by default. A bare `@Field()` is assumed to be `String` unless you build with `strictTypes: true`.

**Scalars** — `ID`, `Int`, `Float`, `Str`, `Bool`, `DateTime`, `Json`

**Schema** — `buildSemanticSchema(options?)`, `createGraphQLHandler(api, options?)`, `DateTimeScalar`, `JSONScalar`

**Core (no `graphql` needed)** — `buildTypeGraph(options?)`, `printSDL(graph, options?)`, `printTypeNode(node)`, `SemanticRegistry`, `getRegistry()`, `setRegistry(registry)`, `BatchLoader`, `SemanticSchemaError`, `SemanticBoundaryError`

**Escape hatches** — `hydrate(Class, value)`, `ResolverFactory`, `containerEventIterator(container, event, transform)`

## Things that will bite you

- **Types are runtime markers.** `@Field(() => Int)`, never a TypeScript annotation. Build with `strictTypes: true` to turn a missing type into an error instead of a silent `String`.
- **Argument names come from the source.** They are parsed from the method signature, so pass them explicitly — `@Arg('id', () => ID)` — and minification cannot rename them out from under you.
- **Decorators write to whichever registry is current when the class is defined**, which is import time. That is the global registry unless you `setRegistry()` first. Give an application its own `SemanticRegistry` if anything else in the process also declares semantic types — a second schema in the same test run, for instance — and pass it as `buildSemanticSchema({ registry })`.
- **Enums and classes are referenced through thunks.** `() => Genre`, not `Genre`; a bare object is read as an options bag.

## Example

A three-context worked example — batching, boundaries, entity actions, subscriptions over a WebSocket, a context-filtered public schema and GraphiQL — lives in [`../../examples/packages/graphql`](../../examples/packages/graphql).

## License

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
