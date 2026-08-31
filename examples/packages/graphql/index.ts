/**
 * A runnable tour of `@di-framework/graphql`: `bun run start`.
 *
 * Every section below is also asserted in `index.test.ts`.
 */

import { useContainer } from '@di-framework/core';
import type { ExecutionResult } from 'graphql';
import type { LibraryContext } from './domain/context.ts';
import { ReviewRepository } from './domain/reviews.ts';
import { library, publicCatalog } from './schema.ts';

const librarian: LibraryContext = { memberId: 'm1', roles: ['librarian'] };

/** A fresh context object per request is what makes batching request-scoped. */
function run(query: string, context: LibraryContext = { memberId: 'm1' }, variables?: any) {
  return library.execute({ query, context, variables });
}

function show(title: string, result: ExecutionResult): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  if (result.errors)
    console.log(
      'errors:',
      result.errors.map((error) => error.message),
    );
  if (result.data) console.log(JSON.stringify(result.data, null, 2));
}

export async function runLibraryExample(): Promise<void> {
  /* 1. The schema the decorators produced ------------------------------- */

  console.log(`bounded contexts: ${library.contexts.join(', ')}`);
  console.log(`queries:          ${library.graph.query.fields.map((f) => f.name).join(', ')}`);
  console.log(`mutations:        ${library.graph.mutation?.fields.map((f) => f.name).join(', ')}`);
  console.log(
    `subscriptions:    ${library.graph.subscription?.fields.map((f) => f.name).join(', ')}`,
  );

  /* 2. One query, three contexts ---------------------------------------- */

  // `reviews` and `onLoan` are contributed to Book by Reviews and Lending.
  // Catalog does not know they exist; the client cannot tell the difference.
  show(
    'a book, with fields from all three contexts',
    await run(`{
      book(id: "b1") {
        title
        shelfLabel
        genre
        publishedAt
        reviews { headline body }
        averageRating
        onLoan
      }
    }`),
  );

  /* 3. Batching: no N+1 across the boundary ------------------------------ */

  const reviews = useContainer().resolve(ReviewRepository);
  const before = reviews.reads;
  await run('{ books { id reviews { id } averageRating } }');
  console.log(
    `\nreviews read ${reviews.reads - before}× for 3 books × 2 fields ` +
      '(batched by @Field({ batch }))',
  );

  /* 4. Mutations: portal actions and input objects ----------------------- */

  show(
    'postReview — the input arrives as a ReviewInput instance',
    await run(
      `mutation ($input: ReviewInput!) {
        postReview(input: $input) { id rating headline memberId }
      }`,
      { memberId: 'm2' },
      // 9 is clamped to 5 by a method on the input class.
      { input: { bookId: 'b3', rating: 9, body: 'Read it in one sitting.' } },
    ),
  );

  show(
    'addBook — authorization is a domain decision',
    await run(
      `mutation {
        addBook(input: {
          title: "The Dispossessed",
          author: "Ursula K. Le Guin",
          genre: Fiction,
          publishedAt: "1974-05-01T00:00:00.000Z"
        }) { id title shelfLabel }
      }`,
      librarian,
    ),
  );

  show(
    'addBook — same mutation, no librarian role',
    await run(`mutation {
    addBook(input: {
      title: "Noop", author: "Nobody", genre: Fiction,
      publishedAt: "2024-01-01T00:00:00.000Z"
    }) { id }
  }`),
  );

  /* 5. Actions that live on the entity ----------------------------------- */

  // `loanCheckIn` was never written as a resolver: it is Loan.checkIn(), keyed
  // by the loan id and loaded through the type's @Lookup.
  show(
    'loanCheckIn — behaviour on the object that owns the invariant',
    await run('mutation { loanCheckIn(id: "l1") { id state renewable } }'),
  );

  show(
    'loanCheckIn again — the invariant holds',
    await run('mutation { loanCheckIn(id: "l1") { id state } }'),
  );

  show(
    'loanRenew — a returned loan cannot be renewed',
    await run('mutation { loanRenew(id: "l1", days: 7) { dueAt } }'),
  );

  /* 6. Subscriptions over the container's event bus ---------------------- */

  const stream = await library.subscribe({
    query: `subscription { loanCheckedOut(memberId: "m2") { id memberId book { title } } }`,
    context: { memberId: 'm2' },
  });

  if (Symbol.asyncIterator in stream) {
    const iterator = stream as AsyncIterableIterator<ExecutionResult>;

    // Two checkouts; the filter drops the one that is not m2's.
    await run('mutation { checkOut(bookId: "b3") { id } }', { memberId: 'm1' });
    await run('mutation { checkOut(bookId: "b2") { id } }', { memberId: 'm2' });

    const event = await iterator.next();
    show('subscription — @Publisher("loan.checkedOut") delivered over GraphQL', event.value);
    await iterator.return?.();
  }

  /* 7. Contexts are a deployment seam ------------------------------------ */

  const publicTypes = publicCatalog.graph.objects.map((object) => object.name);
  const publicBook = publicCatalog.graph.objects.find((object) => object.name === 'Book');
  console.log(`\npublic schema contexts: ${publicCatalog.contexts.join(', ')}`);
  console.log(`public schema types:    ${publicTypes.join(', ')}`);
  console.log(`public Book fields:     ${publicBook?.fields.map((f) => f.name).join(', ')}`);
  console.log('(no Loan, and no onLoan on Book — Lending was not built into this schema)');

  /* 8. SDL as an artifact ------------------------------------------------- */

  console.log('\n── SDL (excerpt) ───────────────────────────────────────────');
  console.log(library.sdl.split('\n').slice(0, 24).join('\n'));
}

if (import.meta.main) await runLibraryExample();

export * from './schema.ts';
