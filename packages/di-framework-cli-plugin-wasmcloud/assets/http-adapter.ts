import './fetch-runtime.ts';
import 'virtual:di-framework-wasmcloud-guests';
import application from 'virtual:di-framework-application';
import { Fields, Request as WasiRequest, Response as WasiResponse } from 'wasi:http/types@0.3.0';

type Application =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

type WasiResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };
type WasiOk = { tag: 'ok'; val: undefined };

function methodName(method: { tag: string; val?: string } | undefined): string {
  if (method === undefined) return 'GET';
  return method.tag === 'other' ? (method.val ?? 'GET') : method.tag.toUpperCase();
}

function firstOfTuple<T>(value: T | [T, ...unknown[]] | { res: T }): T {
  if (Array.isArray(value)) return value[0];
  if (value !== null && typeof value === 'object' && 'res' in value) return value.res;
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

async function* bytesAsStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function toWebRequest(incoming: {
  getMethod(): { tag: string; val?: string } | undefined;
  getScheme(): { tag: string } | undefined | null;
  getAuthority(): string | undefined | null;
  getPathWithQuery(): string | undefined | null;
  getHeaders(): { copyAll(): Array<[string, Uint8Array]> };
}): Promise<Request> {
  const method = methodName(incoming.getMethod());
  const schemeValue = incoming.getScheme();
  const scheme = schemeValue?.tag === 'HTTPS' ? 'https' : 'http';
  const authority = incoming.getAuthority() ?? 'localhost';
  const path = incoming.getPathWithQuery() ?? '/';
  const decoder = new TextDecoder();
  const headers = new Headers();
  for (const [name, value] of incoming.getHeaders().copyAll()) {
    headers.append(name, decoder.decode(value));
  }

  if (method === 'GET' || method === 'HEAD') {
    return new Request(`${scheme}://${authority}${path}`, { method, headers });
  }

  let stream: AsyncIterable<Uint8Array> | undefined;
  try {
    const consumed = (
      WasiRequest as unknown as {
        consumeBody(request: unknown, res: Promise<WasiOk>): unknown;
      }
    ).consumeBody(incoming, Promise.resolve({ tag: 'ok', val: undefined }));
    const body = firstOfTuple(
      consumed as AsyncIterable<Uint8Array> | [AsyncIterable<Uint8Array>, ...unknown[]],
    );
    if (isAsyncIterable(body)) stream = body;
  } catch {
    stream = undefined;
  }

  return new Request(`${scheme}://${authority}${path}`, {
    method,
    headers,
    body: stream as BodyInit | undefined,
  });
}

async function dispatch(request: Request): Promise<Response> {
  const handler = application as Application;
  const response =
    typeof handler === 'function' ? await handler(request) : await handler.fetch(request);

  if (!(response instanceof Response)) {
    throw new TypeError('The default application export must return a Web Response object');
  }

  return response;
}

async function responseContents(response: Response): Promise<AsyncIterable<Uint8Array> | null> {
  const body = response.body;
  if (isAsyncIterable(body)) return body;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > 0 ? bytesAsStream(bytes) : null;
}

async function fromWebResponse(response: Response): Promise<unknown> {
  const encoder = new TextEncoder();
  const headerPairs: Array<[string, Uint8Array]> = [];
  response.headers.forEach((value, name) => {
    headerPairs.push([name, encoder.encode(value)]);
  });
  const fields = Fields.fromList(headerPairs);
  const created = (
    WasiResponse as unknown as {
      new: (
        headers: unknown,
        contents: AsyncIterable<Uint8Array> | null,
        trailers: Promise<WasiResult<null>>,
      ) => unknown;
    }
  ).new(fields, await responseContents(response), Promise.resolve({ tag: 'ok', val: null }));
  const outgoing = firstOfTuple(created as { setStatusCode?(status: number): void });
  outgoing.setStatusCode?.(response.status);
  return outgoing;
}

export const handler = {
  async handle(incoming: Parameters<typeof toWebRequest>[0]): Promise<unknown> {
    try {
      return await fromWebResponse(await dispatch(await toWebRequest(incoming)));
    } catch (error) {
      console.error('Unhandled DI Framework request error', error);
      return await fromWebResponse(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
  },
};
