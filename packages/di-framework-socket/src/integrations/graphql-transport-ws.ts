/**
 * Minimal `graphql-transport-ws` server implementation.
 *
 * Protocol subset used by GraphiQL / graphql-ws clients:
 * connection_init → connection_ack, subscribe → next* → complete, complete, ping/pong.
 *
 * Deliberately free of `@di-framework/graphql` and `graphql` dependencies so this
 * package stays usable without those peers. Pass `execute` / `subscribe` from your schema.
 */

export interface GqlExecuteRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
  context?: unknown;
}

export interface GqlExecutionResult {
  data?: unknown;
  // Structural; GraphQLError is compatible without an index signature.
  errors?: readonly { message: string }[];
}

export interface GraphqlTransportWsOptions<TContext = unknown> {
  // Accept any execute/subscribe shapes (e.g. graphql-js ExecutionResult) via
  // structural typing on the wire protocol.
  execute: (request: GqlExecuteRequest) => Promise<GqlExecutionResult>;
  subscribe: (
    request: GqlExecuteRequest,
  ) => Promise<AsyncIterableIterator<GqlExecutionResult> | GqlExecutionResult>;
  /** Build context from connection_init payload (and optional upgrade hints). */
  contextFromConnectionInit?: (
    payload: Record<string, unknown> | null | undefined,
    socketData: GraphqlTransportWsSocketData<TContext>,
  ) => TContext | Promise<TContext>;
  /** Initial context before connection_init (e.g. from HTTP upgrade headers). */
  initialContext?: TContext | (() => TContext);
  /**
   * Detect subscription operations. Defaults to a lightweight scan that does not
   * require the `graphql` package. Override with `getOperationAST` when available.
   */
  isSubscription?: (query: string, operationName?: string | null) => boolean;
}

export interface GraphqlTransportWsSocketData<TContext = unknown> {
  context: TContext;
  operations: Map<string, AsyncIterableIterator<GqlExecutionResult>>;
  /** True after connection_init / connection_ack. */
  acknowledged: boolean;
}

export type GraphqlWsSend = (message: unknown) => void;

export interface GraphqlTransportWsHandlers<TContext = unknown> {
  /** Create per-connection state for Bun `server.upgrade({ data })`. */
  createData(
    seed?: Partial<GraphqlTransportWsSocketData<TContext>>,
  ): GraphqlTransportWsSocketData<TContext>;
  /** Bun `WebSocketHandler` (message + close). */
  websocket: {
    message(
      socket: {
        data: GraphqlTransportWsSocketData<TContext>;
        send: (data: string) => void;
        close: (code?: number, reason?: string) => void;
      },
      raw: string | ArrayBuffer | Uint8Array,
    ): void;
    close(socket: { data: GraphqlTransportWsSocketData<TContext> }): void;
  };
  /** Handle one raw message for a custom transport. */
  handleMessage(
    send: GraphqlWsSend,
    data: GraphqlTransportWsSocketData<TContext>,
    raw: string | Uint8Array,
    close?: (code?: number, reason?: string) => void,
  ): void;
  handleClose(data: GraphqlTransportWsSocketData<TContext>): void;
  /** Subprotocol clients must negotiate. */
  readonly subprotocol: 'graphql-transport-ws';
}

function defaultIsSubscription(query: string, operationName?: string | null): boolean {
  const stripped = query
    .replace(/#[^\n]*/g, '')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

  if (operationName) {
    const re = new RegExp(
      String.raw`\b(query|mutation|subscription)\s+${escapeRegExp(operationName)}\b`,
    );
    const m = stripped.match(re);
    if (m) return m[1] === 'subscription';
  }

  // Anonymous / first operation keyword
  const m = stripped.match(/\b(query|mutation|subscription)\b/);
  if (m) return m[1] === 'subscription';
  // Shorthand queries have no keyword — treat as query
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Protocol requires a non-empty operation id on subscribe/complete.
 * Missing ids must not coerce to the string `"undefined"` (which collides).
 */
function requireOperationId(
  id: unknown,
  close?: (code?: number, reason?: string) => void,
): string | null {
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  close?.(4400, 'Invalid message: operation id is required');
  return null;
}

function resolveInitialContext<TContext>(
  initial: GraphqlTransportWsOptions<TContext>['initialContext'],
): TContext {
  if (typeof initial === 'function') return (initial as () => TContext)();
  return (initial ?? ({} as TContext)) as TContext;
}

/**
 * Create a reusable `graphql-transport-ws` handler set for Bun or any duplex.
 */
export function createGraphqlTransportWs<TContext = unknown>(
  options: GraphqlTransportWsOptions<TContext>,
): GraphqlTransportWsHandlers<TContext> {
  const isSubscription = options.isSubscription ?? defaultIsSubscription;

  function createData(
    seed?: Partial<GraphqlTransportWsSocketData<TContext>>,
  ): GraphqlTransportWsSocketData<TContext> {
    return {
      context: seed?.context ?? resolveInitialContext(options.initialContext),
      operations: seed?.operations ?? new Map(),
      acknowledged: seed?.acknowledged ?? false,
    };
  }

  function sendJson(send: GraphqlWsSend, message: unknown): void {
    send(message);
  }

  async function startOperation(
    send: GraphqlWsSend,
    data: GraphqlTransportWsSocketData<TContext>,
    id: string,
    payload: {
      query?: string;
      variables?: Record<string, unknown>;
      operationName?: string | null;
    },
  ): Promise<void> {
    const request: GqlExecuteRequest = {
      query: String(payload?.query ?? ''),
      variables: payload?.variables ?? undefined,
      operationName: payload?.operationName ?? undefined,
      context: data.context,
    };

    if (!isSubscription(request.query, request.operationName)) {
      sendJson(send, { id, type: 'next', payload: await options.execute(request) });
      sendJson(send, { id, type: 'complete' });
      return;
    }

    const stream = await options.subscribe(request);
    if (!(stream && typeof stream === 'object' && Symbol.asyncIterator in stream)) {
      sendJson(send, {
        id,
        type: 'error',
        payload: (stream as GqlExecutionResult)?.errors ?? [{ message: 'Subscribe failed' }],
      });
      return;
    }

    const iterator = stream as AsyncIterableIterator<GqlExecutionResult>;
    data.operations.set(id, iterator);

    try {
      for await (const result of iterator) {
        if (!data.operations.has(id)) return;
        sendJson(send, { id, type: 'next', payload: result });
      }
      if (data.operations.has(id)) {
        data.operations.delete(id);
        sendJson(send, { id, type: 'complete' });
      }
    } catch (error) {
      data.operations.delete(id);
      sendJson(send, { id, type: 'error', payload: [{ message: String(error) }] });
    }
  }

  function handleMessage(
    sendRaw: GraphqlWsSend,
    data: GraphqlTransportWsSocketData<TContext>,
    raw: string | Uint8Array,
    close?: (code?: number, reason?: string) => void,
  ): void {
    const send: GraphqlWsSend = (message) => {
      sendRaw(typeof message === 'string' ? message : JSON.stringify(message));
    };

    let message: { type?: string; id?: string; payload?: unknown };
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      message = JSON.parse(text);
    } catch {
      close?.(4400, 'Invalid message');
      return;
    }

    switch (message.type) {
      case 'connection_init': {
        void (async () => {
          try {
            if (options.contextFromConnectionInit) {
              data.context = await options.contextFromConnectionInit(
                (message.payload as Record<string, unknown>) ?? {},
                data,
              );
            } else if (message.payload && typeof message.payload === 'object') {
              data.context = {
                ...(data.context as object),
                ...(message.payload as object),
              } as TContext;
            }
            data.acknowledged = true;
            send({ type: 'connection_ack' });
          } catch (error) {
            close?.(4403, error instanceof Error ? error.message : 'Unauthorized');
          }
        })();
        return;
      }

      case 'ping':
        send({ type: 'pong' });
        return;

      case 'pong':
        return;

      case 'subscribe': {
        if (!data.acknowledged) {
          close?.(4401, 'Unauthorized');
          return;
        }
        const opId = requireOperationId(message.id, close);
        if (opId === null) return;
        void startOperation(
          send,
          data,
          opId,
          (message.payload ?? {}) as {
            query?: string;
            variables?: Record<string, unknown>;
            operationName?: string | null;
          },
        ).then(
          () => {},
          (error) => {
            send({ id: opId, type: 'error', payload: [{ message: String(error) }] });
          },
        );
        return;
      }

      case 'complete': {
        const opId = requireOperationId(message.id, close);
        if (opId === null) return;
        const iterator = data.operations.get(opId);
        data.operations.delete(opId);
        void iterator?.return?.();
        return;
      }

      default:
        close?.(4400, `Unknown message type: ${message.type}`);
        return;
    }
  }

  function handleClose(data: GraphqlTransportWsSocketData<TContext>): void {
    for (const iterator of data.operations.values()) void iterator.return?.();
    data.operations.clear();
  }

  return {
    subprotocol: 'graphql-transport-ws',
    createData,
    handleMessage,
    handleClose,
    websocket: {
      message(socket, raw) {
        handleMessage(
          (msg) => socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
          socket.data,
          typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw,
          (code, reason) => socket.close(code, reason),
        );
      },
      close(socket) {
        handleClose(socket.data);
      },
    },
  };
}

/**
 * Map common `connection_init` credential fields to HTTP-style headers.
 * Compatible with `@di-framework/auth`'s `requestFromConnectionParams` shape.
 */
export function connectionParamsToHeaders(
  params: Record<string, unknown> | null | undefined,
): Headers {
  const headers = new Headers();
  const payload = params ?? {};

  const authorization = payload.authorization ?? payload.Authorization;
  if (typeof authorization === 'string') headers.set('authorization', authorization);
  else if (typeof payload.token === 'string') {
    headers.set('authorization', `Bearer ${payload.token}`);
  }

  const cookie = payload.cookie ?? payload.Cookie;
  if (typeof cookie === 'string') headers.set('cookie', cookie);

  const apiKey = payload.apiKey ?? payload['x-api-key'];
  if (typeof apiKey === 'string') headers.set('x-api-key', apiKey);

  return headers;
}
