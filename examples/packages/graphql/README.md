# `@di-framework/graphql` — a worked example

A three-context library API: **Catalog** owns titles, **Reviews** owns opinions,
**Lending** owns who has what. The domain classes *are* the schema — there is no
SDL document to keep in sync, no resolver map, and no field-by-field mapping
layer.

```bash
bun run serve   # GraphiQL on http://localhost:4000 — start here
bun run start   # a narrated tour in the terminal, printing every result
bun run sdl     # emit schema.graphql / schema.public.graphql
bun test        # the same tour, asserted
```

> Run these from this directory (or from `../..`). Bun reads
> `../../../tsconfig.json` relative to the working directory, and decorators need
> `experimentalDecorators`.

`bun run serve` opens GraphiQL with a tab per idea — the three-context join, the
batched list, the input-object mutation, the entity action (run it twice), the
authorization check, and a live subscription. Headers are prefilled with
`x-member-id: m1` and `x-roles: librarian`; change them to change who you are.

```
GET  /                 GraphiQL
POST /graphql          queries and mutations
WS   /graphql          subscriptions (graphql-transport-ws)
GET  /schema.graphql   the schema, as SDL
```

GraphiQL is loaded from a CDN (pinned and SRI-checked, the versions published in
`graphql/graphiql`'s own `examples/graphiql-cdn`) rather than installed: it is a
React application, and depending on it would mean adding React and a bundler to
an example whose point is that the domain classes are the whole API. The
trade-off is that the playground — and only the playground — needs a network.

## What it shows

| Concern | Where | Notes |
| --- | --- | --- |
| Root queries and mutations | `@Portal` on `CatalogPortal`, `ReviewsPortal`, `LendingPortal` | Portals are DI-managed; collaborators arrive through the constructor. |
| Domain objects as types | `@SemanticType` on `Book`, `Review`, `Loan` | `expose` publishes constructor parameter properties, which cannot carry decorators. |
| Bounded contexts | `@BoundedContext` everywhere | `library.contexts` → `Catalog, Lending, Reviews`. |
| Boundaries that are enforced | `Book`/`Loan` are `boundary: true`; `Review` is not | A cross-context reference to `Review` fails the build — asserted in `index.test.ts`. |
| Extending another context's type | `BookReviews`, `BookAvailability` (`@Extends(() => Book)`) | `Book` grows `reviews`, `averageRating` and `onLoan` without Catalog knowing. |
| Behaviour with the invariant | `Loan.checkIn()`, `Loan.renew()` (`@Action`) | Become `loanCheckIn(id:)` / `loanRenew(id:, days:)`; the entity is loaded via `@Lookup` first, so "you cannot renew a returned loan" cannot be routed around. |
| Re-identifying across a boundary | `Loan.book()` calls `Book.load()` | Lending stores a `bookId` and never touches Catalog's storage. |
| Batching | `@Field({ batch: 'reviewsForBooks' })` | One read per field per request instead of one per book. |
| Input objects with behaviour | `BookInput.slug()`, `ReviewInput.clampedRating()` | GraphQL's plain input values are hydrated back onto the class. |
| Hydration | `Book.shelfLabel()`, `Loan.renewable()` | Repository rows are plain data; they get their type's behaviour before resolution. |
| Enums and scalars | `Genre`, `LoanState`, `ID`/`Int`/`Float`/`DateTime`/`JSON` | Types are runtime markers — no `reflect-metadata`. |
| Request context | `@Ctx()`, and `myLoans(ctx)` by convention | Authorization (`requireLibrarian`) is a domain decision, not middleware. |
| Resolve info | `@Info()` in `CatalogPortal.books` | Feeds a `QueryStats` component. |
| Subscriptions | `@Publisher('loan.checkedOut')` → `@Subscription(...)` | The service publishes on the container and knows nothing about GraphQL. `filter` sees the raw publisher envelope. |
| Subscriptions over the wire | `sockets` in `server.ts` | ~60 lines of `graphql-transport-ws` so GraphiQL can stream them; the round trip is asserted in `index.test.ts`. |
| Contexts as a deployment seam | `publicCatalog` in `schema.ts` | Built from `['Catalog', 'Reviews']`: no `Loan`, and no `onLoan` on `Book`. |
| SDL as an artifact | `emit-sdl.ts` | `printSDL` comes from `@di-framework/graphql/core`, which never imports `graphql`. |
| Owning your registry | `domain/registry.ts` | Decorators write to whichever registry is current at import time; this app uses its own, so nothing else in the process can leak into its schema. |
| Transport | `server.ts` | `createGraphQLHandler` is a plain `Request -> Response`. |

## Layout

```
domain/registry.ts   the registry these decorators write to
domain/context.ts    the per-request context, and what authorization means
domain/catalog.ts    Book, BookInput, CatalogPortal   — owns titles
domain/reviews.ts    Review, BookReviews, ReviewsPortal — owns opinions, extends Book
domain/lending.ts    Loan, BookAvailability, LendingPortal — owns loans, extends Book
schema.ts            builds the full schema and a context-filtered one
server.ts            Bun.serve: HTTP handler, WebSocket subscriptions, GraphiQL
playground.html      GraphiQL, with a tab per idea
emit-sdl.ts          writes schema.graphql and schema.public.graphql
index.ts             the narrated tour
index.test.ts        the same thing, asserted
```

## The shape of it

One query reaches three contexts, and the client cannot tell:

```graphql
{
  book(id: "b1") {
    title          # Catalog
    shelfLabel     # Catalog, derived on the class
    reviews {      # Reviews, contributed via @Extends and batched
      headline
    }
    averageRating  # Reviews
    onLoan         # Lending
  }
}
```

Mutations that carry an invariant are declared on the object that owns it:

```graphql
mutation {
  loanCheckIn(id: "l1") { state renewable }   # Loan.checkIn()
}
```

And the SDL that falls out records who owns what:

```graphql
type Book @key(fields: "id") @context(name: "Catalog") {
  reviews: [Review!]! @context(name: "Reviews")
  onLoan: Int! @context(name: "Lending")
}
```

## Two things that will bite you

- **Types are runtime markers.** `@Field(() => Int)`, not a TypeScript
  annotation — decorator metadata is deliberately not used. Building with
  `strictTypes: true` (as `schema.ts` does) turns a missing type into an error
  instead of a silent `String`.
- **Argument names come from the source.** Pass them explicitly —
  `@Arg('id', () => ID)` — and minification cannot rename them out from under
  you.
