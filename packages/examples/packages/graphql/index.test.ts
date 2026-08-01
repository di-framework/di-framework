import { describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import {
  BoundedContext,
  buildTypeGraph,
  Field,
  Portal,
  printSDL,
  SemanticRegistry,
  SemanticType,
  setRegistry,
} from '@di-framework/graphql';
import type { ExecutionResult } from 'graphql';
import { QueryStats } from './domain/catalog.ts';
import type { LibraryContext } from './domain/context.ts';
import { ReviewRepository } from './domain/reviews.ts';
import { library, publicCatalog } from './schema.ts';
import { handler, serve } from './server.ts';

function run(query: string, context: LibraryContext = { memberId: 'm1' }, variables?: any) {
  return library.execute({ query, context, variables });
}

function data(result: ExecutionResult): any {
  if (result.errors) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

describe('the schema the decorators produced', () => {
  it('collects one root per portal, plus the entity actions', () => {
    expect(library.contexts).toEqual(['Catalog', 'Lending', 'Reviews']);
    expect(library.graph.query.fields.map((field) => field.name).sort()).toEqual([
      'book',
      'books',
      'latestReviews',
      'loan',
      'myLoans',
    ]);
    expect(library.graph.mutation?.fields.map((field) => field.name).sort()).toEqual([
      'addBook',
      'checkOut',
      'loanCheckIn',
      'loanRenew',
      'postReview',
    ]);
    expect(library.graph.subscription?.fields.map((field) => field.name).sort()).toEqual([
      'loanCheckedOut',
      'reviewPosted',
    ]);
  });

  it('assembles Book from three contexts without Catalog knowing', () => {
    const book = library.graph.objects.find((object) => object.name === 'Book');
    expect(book?.context).toBe('Catalog');
    expect(book?.fields.map((field) => field.name).sort()).toEqual([
      'age',
      'author',
      'averageRating',
      'copies',
      'genre',
      'id',
      'metadata',
      'onLoan',
      'publishedAt',
      'reviews',
      'shelfLabel',
      'title',
    ]);
    // The contributed fields still belong to the context that declared them.
    expect(book?.fields.find((field) => field.name === 'reviews')?.context).toBe('Reviews');
    expect(book?.fields.find((field) => field.name === 'onLoan')?.context).toBe('Lending');
  });

  it('prints SDL describing the same graph the executable schema was built from', async () => {
    const graphql = await import('graphql');

    /** Every type, with its fields and argument types. */
    function shape(schema: import('graphql').GraphQLSchema): Record<string, string[]> {
      const out: Record<string, string[]> = {};
      for (const [name, type] of Object.entries(schema.getTypeMap())) {
        if (name.startsWith('__')) continue;
        if (graphql.isObjectType(type) || graphql.isInputObjectType(type)) {
          out[name] = Object.values(type.getFields())
            .map((field) => {
              const args = graphql.isObjectType(type)
                ? (field as any).args.map((arg: any) => `${arg.name}: ${arg.type}`).join(', ')
                : '';
              return `${field.name}(${args}): ${field.type}`;
            })
            .sort();
        } else if (graphql.isEnumType(type)) {
          out[name] = type.getValues().map((value) => value.name);
        } else {
          out[name] = [];
        }
      }
      return out;
    }

    // The SDL artifact and the executable schema are two renderings of one graph.
    expect(shape(graphql.buildSchema(printSDL(library.graph)))).toEqual(shape(library.schema));
    // The annotated SDL is still valid SDL, directives and all.
    expect(() => graphql.buildSchema(library.sdl)).not.toThrow();
  });

  it('records semantic ownership in the SDL', () => {
    expect(library.sdl).toContain('type Book @key(fields: "id") @context(name: "Catalog")');
  });
});

describe('resolution', () => {
  it('hydrates repository rows so the class methods apply', async () => {
    const result = data(await run('{ book(id: "b1") { title shelfLabel genre } }'));
    expect(result.book).toEqual({
      title: 'The Left Hand of Darkness',
      shelfLabel: 'FIC-GUIN-b1',
      genre: 'Fiction',
    });
  });

  it('serializes DateTime and JSON scalars', async () => {
    const result = data(await run('{ book(id: "b1") { publishedAt metadata } }'));
    expect(result.book.publishedAt).toBe('1969-03-01T00:00:00.000Z');
    expect(result.book.metadata).toEqual({ awards: ['Hugo', 'Nebula'] });
  });

  it('crosses a boundary in both directions', async () => {
    const result = data(await run('{ loan(id: "l2") { memberId state book { title genre } } }'));
    expect(result.loan).toEqual({
      memberId: 'm2',
      state: 'Returned',
      book: { title: 'Structure and Interpretation of Computer Programs', genre: 'Reference' },
    });
  });

  it('reads the request context through @Ctx() and by convention', async () => {
    const mine = data(await run('{ myLoans { id memberId } }', { memberId: 'm2' }));
    expect(mine.myLoans.map((loan: any) => loan.id)).toEqual(['l2']);

    const anonymous = await run('{ myLoans { id } }', {});
    expect(anonymous.errors?.[0]?.message).toContain('Not authenticated');
  });

  it('injects resolve info', async () => {
    const stats = useContainer().resolve(QueryStats);
    const before = stats.selections.length;
    await run('{ books { id title } }');
    expect(stats.selections.slice(before)).toEqual([{ field: 'books', count: 2 }]);
  });

  it('batches contributed fields instead of N+1ing them', async () => {
    const reviews = useContainer().resolve(ReviewRepository);
    const before = reviews.reads;

    const result = data(await run('{ books { id reviews { id } averageRating } }'));

    expect(result.books.length).toBeGreaterThanOrEqual(3);
    // Two batched fields over N books: two reads, not 2N.
    expect(reviews.reads - before).toBe(2);
  });

  it('scopes batching to a single request', async () => {
    const reviews = useContainer().resolve(ReviewRepository);
    const before = reviews.reads;
    await run('{ books { reviews { id } } }');
    await run('{ books { reviews { id } } }');
    expect(reviews.reads - before).toBe(2);
  });
});

describe('mutations', () => {
  it('hydrates input objects onto their @InputType class', async () => {
    const result = data(
      await run(
        'mutation ($input: ReviewInput!) { postReview(input: $input) { rating headline memberId } }',
        { memberId: 'm2' },
        { input: { bookId: 'b3', rating: 9 } },
      ),
    );
    // 9 clamped to 5 by ReviewInput.clampedRating().
    expect(result.postReview).toEqual({ rating: 5, headline: '★★★★★', memberId: 'm2' });
  });

  it('enforces authorization declared in the domain', async () => {
    const mutation = `mutation {
      addBook(input: {
        title: "The Dispossessed", author: "Ursula K. Le Guin",
        genre: Fiction, publishedAt: "1974-05-01T00:00:00.000Z"
      }) { id title }
    }`;

    const denied = await run(mutation, { memberId: 'm1', roles: [] });
    expect(denied.errors?.[0]?.message).toContain('not a librarian');

    const allowed = data(await run(mutation, { memberId: 'm1', roles: ['librarian'] }));
    expect(allowed.addBook).toEqual({ id: 'the-dispossessed', title: 'The Dispossessed' });
  });

  it('runs @Action methods on the entity that owns the invariant', async () => {
    const loan = data(await run('mutation { loanCheckIn(id: "l1") { id state renewable } }'));
    expect(loan.loanCheckIn).toEqual({ id: 'l1', state: 'Returned', renewable: false });

    const twice = await run('mutation { loanCheckIn(id: "l1") { state } }');
    expect(twice.errors?.[0]?.message).toContain('already returned');

    const renew = await run('mutation { loanRenew(id: "l1", days: 7) { dueAt } }');
    expect(renew.errors?.[0]?.message).toContain('cannot be renewed');
  });

  it('reports a missing entity from the @Lookup', async () => {
    const result = await run('mutation { loanCheckIn(id: "nope") { state } }');
    expect(result.errors?.[0]?.message).toContain("Loan 'nope' was not found");
  });
});

describe('subscriptions', () => {
  it('delivers @Publisher events, filtered', async () => {
    const stream = await library.subscribe({
      query: 'subscription { loanCheckedOut(memberId: "m2") { memberId book { title } } }',
      context: { memberId: 'm2' },
    });
    expect(Symbol.asyncIterator in stream).toBe(true);
    const iterator = stream as AsyncIterableIterator<ExecutionResult>;

    // The first checkout belongs to m1 and is filtered out.
    await run('mutation { checkOut(bookId: "b3") { id } }', { memberId: 'm1' });
    await run('mutation { checkOut(bookId: "b1") { id } }', { memberId: 'm2' });

    const event = await iterator.next();
    expect(event.value?.data).toEqual({
      loanCheckedOut: {
        memberId: 'm2',
        book: { title: 'The Left Hand of Darkness' },
      },
    });

    await iterator.return?.();
  });
});

describe('bounded contexts', () => {
  it('builds a smaller schema from a subset of contexts', () => {
    expect(publicCatalog.contexts).toEqual(['Catalog', 'Reviews']);
    expect(publicCatalog.graph.objects.map((object) => object.name)).toEqual(['Book', 'Review']);

    const book = publicCatalog.graph.objects.find((object) => object.name === 'Book');
    // Reviews' contribution survives; Lending's leaves with its context.
    expect(book?.fields.map((field) => field.name)).toContain('reviews');
    expect(book?.fields.map((field) => field.name)).not.toContain('onLoan');
  });

  it('rejects a cross-context reference to a type that is not a boundary', () => {
    // An isolated registry, so this architectural probe does not leak into the
    // real schema. This is the check worth running in CI.
    const previous = setRegistry(new SemanticRegistry());
    try {
      @BoundedContext('Reviews')
      @SemanticType({ description: 'Internal to Reviews, exactly like the real one.' })
      class InternalReview {
        @Field(() => String)
        body(): string {
          return '';
        }
      }

      @BoundedContext('Lending')
      @Portal()
      class LeakyPortal {
        @Field(() => InternalReview)
        review(): InternalReview {
          return new InternalReview();
        }
      }
      void LeakyPortal;

      expect(() => buildTypeGraph()).toThrow(/not a boundary type/);
    } finally {
      setRegistry(previous);
    }
  });
});

describe('http', () => {
  it('serves POST queries with a context built from the request', async () => {
    const response = await handler(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-member-id': 'm2' },
        body: JSON.stringify({ query: '{ myLoans { id memberId } }' }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data.myLoans[0].memberId).toBe('m2');
  });

  it('rejects an invalid query without executing it', async () => {
    const response = await handler(new Request('http://localhost/graphql?query={ notAField }'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.errors[0].message).toContain('Cannot query field');
  });
});

describe('the server', () => {
  it('serves GraphiQL at the root and the SDL beside it', async () => {
    const server = serve(0);
    try {
      const page = await fetch(`http://localhost:${server.port}/`);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('createGraphiQLFetcher');

      const sdl = await fetch(`http://localhost:${server.port}/schema.graphql`);
      expect(await sdl.text()).toContain('type Book');
    } finally {
      server.stop(true);
    }
  });

  /**
   * The playground talks graphql-transport-ws for subscriptions, so the whole
   * round trip — init, subscribe, a @Publisher event, complete — is worth
   * asserting rather than clicking.
   */
  it('streams subscriptions over graphql-transport-ws', async () => {
    const server = serve(0);
    const socket = new WebSocket(`ws://localhost:${server.port}/graphql`, 'graphql-transport-ws');
    const received: any[] = [];

    let ticker: ReturnType<typeof setInterval> | undefined;

    try {
      const next = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 5000);

        socket.addEventListener('error', () => reject(new Error('socket error')));
        socket.addEventListener('open', () => {
          // A socket has no per-request headers; graphql-ws clients pass them
          // in the init payload, and the server turns them into the context.
          socket.send(
            JSON.stringify({ type: 'connection_init', payload: { 'x-member-id': 'm2' } }),
          );
        });

        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          received.push(message.type);

          if (message.type === 'connection_ack') {
            socket.send(
              JSON.stringify({
                id: '1',
                type: 'subscribe',
                payload: {
                  query:
                    'subscription { loanCheckedOut(memberId: "m2") { memberId book { title } } }',
                },
              }),
            );
            // The protocol has no "subscribed" acknowledgement, so keep checking
            // books out until one arrives. Each round does m1 first: the
            // subscription's filter drops it and only m2's is delivered.
            ticker = setInterval(async () => {
              await run('mutation { checkOut(bookId: "b3") { id } }', { memberId: 'm1' });
              await run('mutation { checkOut(bookId: "b1") { id } }', { memberId: 'm2' });
            }, 100);
          }

          if (message.type === 'next') {
            clearTimeout(timer);
            resolve(message.payload);
          }
        });
      });

      expect(received[0]).toBe('connection_ack');
      expect(next.data).toEqual({
        loanCheckedOut: { memberId: 'm2', book: { title: 'The Left Hand of Darkness' } },
      });
    } finally {
      clearInterval(ticker);
      socket.close();
      server.stop(true);
    }
  });
});
