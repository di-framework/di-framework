import { JSON_RPC_ERRORS, parseJsonRpc, rpcFailure } from '../codec.ts';
import { createRpcDispatcher } from '../dispatcher.ts';
import type {
  RpcContainer,
  RpcServerInterceptor,
  RpcTransport,
  RpcTransportHandler,
} from '../types.ts';

export interface HttpRpcTransportOptions {
  url: string | URL;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  headers?: HeadersInit;
}

/** Client-side JSON-RPC over HTTP transport. */
export function httpTransport(options: HttpRpcTransportOptions): RpcTransport {
  const handlers = new Set<RpcTransportHandler>();
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async send(payload) {
      const response = await fetcher(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(payload),
      });
      if (response.status === 204) return;
      if (!response.ok) {
        throw new Error(`HTTP RPC failed with ${response.status} ${response.statusText}`);
      }
      const result = await response.json();
      await Promise.all([...handlers].map((handler) => handler(result)));
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      handlers.clear();
    },
  };
}

export interface CreateHttpRpcHandlerOptions {
  path?: string;
  container?: RpcContainer;
  interceptors?: readonly RpcServerInterceptor[];
}

/** Fetch-compatible JSON-RPC endpoint for Bun, Workers, and Node adapters. */
export function createHttpRpcHandler(options: CreateHttpRpcHandlerOptions = {}) {
  const path = options.path ?? '/rpc';
  const dispatcher = createRpcDispatcher({
    container: options.container,
    interceptors: options.interceptors,
  });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== path) return new Response('Not Found', { status: 404 });
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST' },
      });
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json(rpcFailure(null, JSON_RPC_ERRORS.PARSE, 'Parse error'));
    }
    const parsed = parseJsonRpc(text);
    if ('error' in parsed && parsed.id === null) return Response.json(parsed);
    const response = await dispatcher.dispatch(parsed);
    if (response === undefined) return new Response(null, { status: 204 });
    return Response.json(response);
  };
}
