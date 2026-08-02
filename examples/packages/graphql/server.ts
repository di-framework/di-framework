/**
 * The transport: `bun run serve`, then open http://localhost:4000.
 *
 * `createGraphQLHandler` is a plain `Request -> Response` function, so the same
 * handler drops into `Bun.serve`, a Cloudflare Worker, or a
 * `@di-framework/http` route without changing anything about the
 * domain. Subscriptions need a connection rather than a request, so they get a
 * small `graphql-transport-ws` endpoint on the same path.
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
import type { ExecutionResult } from 'graphql';
import { getOperationAST, parse } from 'graphql';
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
/* graphql-transport-ws                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Just enough of the protocol for GraphiQL and `graphql-ws` clients:
 * `connection_init` → `connection_ack`, `subscribe` → a stream of `next`
 * followed by `complete`, and `complete` to stop early.
 */
interface SocketData {
  context: LibraryContext;
  operations: Map<string, AsyncIterableIterator<ExecutionResult>>;
}

type Socket = import('bun').ServerWebSocket<SocketData>;

const send = (socket: Socket, message: unknown) => socket.send(JSON.stringify(message));

function isSubscription(query: string, operationName?: string | null): boolean {
  try {
    return getOperationAST(parse(query), operationName ?? undefined)?.operation === 'subscription';
  } catch {
    return false;
  }
}

async function startOperation(socket: Socket, id: string, payload: any): Promise<void> {
  const request = {
    query: String(payload?.query ?? ''),
    variables: payload?.variables ?? undefined,
    operationName: payload?.operationName ?? undefined,
    context: socket.data.context,
  };

  // Queries and mutations are legal over this transport too, and GraphiQL will
  // send them here if you switch the tab's URL.
  if (!isSubscription(request.query, request.operationName)) {
    send(socket, { id, type: 'next', payload: await library.execute(request) });
    send(socket, { id, type: 'complete' });
    return;
  }

  const stream = await library.subscribe(request);
  if (!(Symbol.asyncIterator in stream)) {
    send(socket, { id, type: 'error', payload: stream.errors ?? [] });
    return;
  }

  const iterator = stream as AsyncIterableIterator<ExecutionResult>;
  socket.data.operations.set(id, iterator);

  for await (const result of iterator) {
    if (!socket.data.operations.has(id)) return; // client sent `complete`
    send(socket, { id, type: 'next', payload: result });
  }

  socket.data.operations.delete(id);
  send(socket, { id, type: 'complete' });
}

const sockets: import('bun').WebSocketHandler<SocketData> = {
  message(socket, raw) {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.close(4400, 'Invalid message');
      return;
    }

    switch (message.type) {
      case 'connection_init':
        // A WebSocket has no per-request headers, so `graphql-ws` clients pass
        // them in the init payload instead.
        socket.data.context = { ...socket.data.context, ...toContext(message.payload ?? {}) };
        send(socket, { type: 'connection_ack' });
        return;

      case 'ping':
        send(socket, { type: 'pong' });
        return;

      case 'pong':
        return;

      case 'subscribe':
        void startOperation(socket, String(message.id), message.payload).catch((error) => {
          send(socket, { id: message.id, type: 'error', payload: [{ message: String(error) }] });
        });
        return;

      case 'complete': {
        const iterator = socket.data.operations.get(String(message.id));
        socket.data.operations.delete(String(message.id));
        void iterator?.return?.();
        return;
      }

      default:
        socket.close(4400, `Unknown message type: ${message.type}`);
        return;
    }
  },

  close(socket) {
    for (const iterator of socket.data.operations.values()) void iterator.return?.();
    socket.data.operations.clear();
  },
};

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const playground = new URL('./playground.html', import.meta.url);

export function serve(port = Number(process.env.PORT ?? 4000)) {
  return Bun.serve({
    port,
    websocket: sockets,
    fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname === '/graphql' && request.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(request, {
          // Echo the subprotocol back; graphql-ws clients insist on it.
          headers: { 'Sec-WebSocket-Protocol': 'graphql-transport-ws' },
          data: { context: toContext({}), operations: new Map() } satisfies SocketData,
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
