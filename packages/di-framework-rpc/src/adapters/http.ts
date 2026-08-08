import { isJsonRpcStreamFrame, JSON_RPC_ERRORS, parseJsonRpc, rpcFailure } from '../codec.ts';
import { createRpcDispatcher } from '../dispatcher.ts';
import type {
  JsonRpcResponse,
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

      const contentType = response.headers.get('content-type') ?? '';
      if (
        contentType.includes('text/event-stream') ||
        contentType.includes('application/x-ndjson')
      ) {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
              if (!jsonText) continue;
              try {
                const parsedFrame = JSON.parse(jsonText);
                await Promise.all([...handlers].map((handler) => handler(parsedFrame)));
              } catch {}
            }
          }
          if (buffer.trim()) {
            const trimmed = buffer.trim();
            const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
            if (jsonText) {
              try {
                const parsedFrame = JSON.parse(jsonText);
                await Promise.all([...handlers].map((handler) => handler(parsedFrame)));
              } catch {}
            }
          }
        }
        return;
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

    let isStreamResponse = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let unaryResponse: JsonRpcResponse | JsonRpcResponse[] | undefined;

    let resolveResponse!: (res: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const dispatchPromise = dispatcher.dispatch(parsed, async (frame) => {
      if (isJsonRpcStreamFrame(frame)) {
        if (!isStreamResponse) {
          isStreamResponse = true;
          resolveResponse(
            new Response(stream, {
              headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            }),
          );
        }
        if (streamController) {
          try {
            streamController.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          } catch {}
          if (frame.stream === 'complete' || frame.stream === 'error') {
            try {
              streamController.close();
            } catch {}
          }
        }
      } else {
        unaryResponse = frame;
      }
    });

    dispatchPromise
      .then((dispatchResult) => {
        if (!isStreamResponse) {
          const finalResult = unaryResponse ?? dispatchResult;
          if (finalResult === undefined) {
            resolveResponse(new Response(null, { status: 204 }));
          } else {
            resolveResponse(Response.json(finalResult));
          }
        }
      })
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        resolveResponse(Response.json(rpcFailure(null, JSON_RPC_ERRORS.SERVER, msg)));
      })
      .finally(() => {
        try {
          streamController?.close();
        } catch {}
      });

    return responsePromise;
  };
}
