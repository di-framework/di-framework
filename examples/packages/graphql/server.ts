/**
 * The transport: `bun run serve`, then open http://localhost:4000.
 *
 * `createGraphQLHandler` is a plain `Request -> Response` function, so the same
 * handler drops into `Bun.serve`, a Cloudflare Worker, or a
 * `@di-framework/http` route without changing anything about the
 * domain. Subscriptions need a connection rather than a request — driven by
 * `@di-framework/socket/graphql` (`graphql-transport-ws`).
 *
 *   GET  /                 GraphiQL, with a tab per idea
 *   POST /graphql          queries and mutations
 *   WS   /graphql          subscriptions (graphql-transport-ws)
 *   GET  /schema.graphql   the schema, as SDL
 *
 *   curl -s localhost:4000/graphql \
 *     -H 'content-type: application/json' \
 *     -H 'x-member-id: m1' \
 *     -d '{"query":"{ myLoans { id daysRemaining book { title } } }"}'
 */

import { createGraphQLHandler } from '@di-framework/graphql';
import { createGraphqlTransportWs } from '@di-framework/socket/graphql';
import type { LibraryContext } from './domain/context.ts';
import { library } from './schema.ts';

/**
 * The one place authentication turns into domain vocabulary. Everything
 * downstream reads `ctx.memberId` through `@Ctx()`.
 */
function toContext(headers: Record<string, string | undefined>): LibraryContext {
  return {
    memberId: headers['x-member-id'] || undefined,
    roles: headers['x-roles']?.split(',').filter(Boolean) ?? [],
  };
}

export const handler = createGraphQLHandler(library, {
  context: (request) =>
    toContext({
      'x-member-id': request.headers.get('x-member-id') ?? undefined,
      'x-roles': request.headers.get('x-roles') ?? undefined,
    }),
});

/* -------------------------------------------------------------------------- */
/* graphql-transport-ws (via @di-framework/socket)                            */
/* -------------------------------------------------------------------------- */

const graphqlWs = createGraphqlTransportWs<LibraryContext>({
  execute: (request) =>
    library.execute({
      query: request.query,
      variables: request.variables ?? undefined,
      operationName: request.operationName ?? undefined,
      context: request.context as LibraryContext | undefined,
    }) as Promise<{ data?: unknown; errors?: readonly { message: string }[] }>,
  subscribe: (request) =>
    library.subscribe({
      query: request.query,
      variables: request.variables ?? undefined,
      operationName: request.operationName ?? undefined,
      context: request.context as LibraryContext | undefined,
    }) as Promise<
      | AsyncIterableIterator<{ data?: unknown; errors?: readonly { message: string }[] }>
      | { data?: unknown; errors?: readonly { message: string }[] }
    >,
  initialContext: () => toContext({}),
  // A WebSocket has no per-request headers, so graphql-ws clients pass them
  // in the init payload instead.
  contextFromConnectionInit: (payload) => {
    const p = (payload ?? {}) as Record<string, string | undefined>;
    return toContext(p);
  },
});

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const playground = new URL('./playground.html', import.meta.url);

export function serve(port = Number(process.env.PORT ?? 4000)) {
  return Bun.serve({
    port,
    websocket: graphqlWs.websocket,
    fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname === '/graphql' && request.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(request, {
          // Echo the subprotocol back; graphql-ws clients insist on it.
          headers: { 'Sec-WebSocket-Protocol': graphqlWs.subprotocol },
          data: graphqlWs.createData({ context: toContext({}) }),
        });
        return upgraded ? undefined : new Response('Upgrade failed', { status: 400 });
      }

      if (pathname === '/graphql') return handler(request);

      // The SDL is a first-class artifact, not something you introspect for.
      if (pathname === '/schema.graphql') {
        return new Response(library.sdl, { headers: { 'content-type': 'text/plain' } });
      }

      if (pathname === '/') return new Response(Bun.file(playground));

      return new Response('Not found', { status: 404 });
    },
  });
}

/** Shared entrypoint so tests can cover the boot banner without import.meta.main. */
export function startFromMain(port = Number(process.env.PORT ?? 4000)) {
  const server = serve(port);
  console.log(`GraphiQL  http://localhost:${server.port}`);
  console.log(`GraphQL   http://localhost:${server.port}/graphql`);
  console.log(`SDL       http://localhost:${server.port}/schema.graphql`);
  console.log(`contexts  ${library.contexts.join(', ')}`);
  return server;
}

if (import.meta.main) {
  startFromMain();
}
