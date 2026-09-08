import { afterEach, describe, expect, it, mock } from 'bun:test';
import { HeadersPolyfill } from '../assets/fetch-runtime';

type ApplicationHandler =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

type Outgoing = {
  headers: unknown;
  contents: unknown;
  trailers: unknown;
  statusCode: number;
  setStatusCode(status: number): void;
};

const applicationState: { current: ApplicationHandler } = {
  current: () => new Response('ok'),
};

function defaultOutgoing(headers: unknown, contents: unknown, trailers: unknown): Outgoing {
  const outgoing: Outgoing = {
    headers,
    contents,
    trailers,
    statusCode: 0,
    setStatusCode(status: number) {
      outgoing.statusCode = status;
    },
  };
  return outgoing;
}

const wasiState = {
  consumeBody: (_request: unknown, _res: Promise<unknown>): unknown => {
    throw new Error('consumeBody was not stubbed');
  },
  newResponse: (headers: unknown, contents: unknown, trailers: unknown): unknown =>
    defaultOutgoing(headers, contents, trailers),
};

mock.module('virtual:di-framework-wasmcloud-guests', () => ({
  guests: {},
}));

mock.module('virtual:di-framework-application', () => ({
  default: (request: Request) => {
    const current = applicationState.current;
    return typeof current === 'function' ? current(request) : current.fetch(request);
  },
}));

mock.module('wasi:http/types@0.3.0', () => ({
  Fields: {
    fromList(entries: Array<[string, Uint8Array]>) {
      return { entries };
    },
  },
  Request: {
    consumeBody(request: unknown, res: Promise<unknown>) {
      return wasiState.consumeBody(request, res);
    },
  },
  Response: {
    new(headers: unknown, contents: unknown, trailers: unknown) {
      return wasiState.newResponse(headers, contents, trailers);
    },
  },
}));

const { handler, requireGuestsObject } = await import('../assets/http-adapter.ts');

function readable(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

function incoming(
  overrides: {
    method?: { tag: string; val?: string };
    scheme?: { tag: string } | null;
    authority?: string | null;
    path?: string | null;
    headers?: Array<[string, Uint8Array]>;
  } = {},
) {
  return {
    getMethod: () => overrides.method,
    getScheme: () => overrides.scheme,
    getAuthority: () => overrides.authority,
    getPathWithQuery: () => overrides.path,
    getHeaders: () => ({
      copyAll: () => overrides.headers ?? [['accept', new TextEncoder().encode('text/plain')]],
    }),
  };
}

afterEach(() => {
  applicationState.current = () => new Response('ok');
  wasiState.consumeBody = () => {
    throw new Error('consumeBody was not stubbed');
  };
  wasiState.newResponse = (headers, contents, trailers) =>
    defaultOutgoing(headers, contents, trailers);
  delete (globalThis as { wit?: unknown }).wit;
});

describe('http adapter', () => {
  it('translates a GET request through the default function export', async () => {
    applicationState.current = () => new Response('hello', { status: 201 });
    const outgoing = (await handler.handle(
      incoming({
        method: { tag: 'get' },
        scheme: { tag: 'HTTPS' },
        authority: 'example.com',
        path: '/greet',
      }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(201);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('hello');
  });

  it('defaults missing method, scheme, authority, and path', async () => {
    const seen: string[] = [];
    applicationState.current = (request) => {
      seen.push(`${request.method} ${request.url}`);
      return new Response(null, { status: 204 });
    };
    const outgoing = (await handler.handle(
      incoming({ method: undefined, scheme: null, authority: null, path: null }),
    )) as Outgoing;
    expect(seen).toEqual(['GET http://localhost/']);
    expect(outgoing.statusCode).toBe(204);
    expect(outgoing.contents).toBeNull();
    await handler.handle(incoming({ method: { tag: 'other' }, path: '/other' }));
    expect(seen).toEqual(['GET http://localhost/', 'GET http://localhost/other']);
  });

  it('maps other methods and consumes a streaming POST body', async () => {
    const seen: string[] = [];
    applicationState.current = {
      async fetch(request) {
        seen.push(`${request.method}:${await request.text()}`);
        return new Response(readable(new Uint8Array([9, 8])));
      },
    };
    wasiState.consumeBody = () => readable(new TextEncoder().encode('payload'));
    const outgoing = (await handler.handle(
      incoming({
        method: { tag: 'other', val: 'PURGE' },
        scheme: { tag: 'HTTP' },
        authority: 'app.local',
        path: '/items',
      }),
    )) as Outgoing;
    expect(seen).toEqual(['PURGE:payload']);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(collected).toEqual([9, 8]);
  });

  it('unwraps consumeBody and Response.new tuples', async () => {
    applicationState.current = async (request) => new Response(await request.text());
    wasiState.consumeBody = () => [readable(new TextEncoder().encode('tuple'))];
    wasiState.newResponse = (headers, contents, trailers) => [
      {
        headers,
        contents,
        trailers,
        statusCode: 0,
        setStatusCode(status: number) {
          (this as Outgoing).statusCode = status;
        },
      } satisfies Outgoing,
    ];
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/tuple' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('tuple');
  });

  it('unwraps result-shaped consumeBody and Response.new values', async () => {
    applicationState.current = () => new Response('res');
    wasiState.consumeBody = () => ({ res: { not: 'iterable' } });
    wasiState.newResponse = (headers, contents, trailers) => ({
      res: {
        headers,
        contents,
        trailers,
        statusCode: 0,
        setStatusCode(status: number) {
          this.statusCode = status;
        },
      } satisfies Outgoing,
    });
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/res' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
  });

  it('ignores consumeBody failures and other-method fallbacks', async () => {
    applicationState.current = (request) => new Response(request.method);
    wasiState.consumeBody = () => {
      throw new Error('no body');
    };
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'put' }, path: '/headless' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
  });

  it('buffers a Response whose body is not an async iterable', async () => {
    class BufferedResponse extends Response {
      constructor() {
        super('buffered');
      }
      override get body(): null {
        return null;
      }
    }
    applicationState.current = () => new BufferedResponse() as Response;
    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('buffered');
  });

  it('encodes headers from a polyfill that only implements forEach via entries', async () => {
    const headers = new HeadersPolyfill([
      ['content-type', 'text/plain'],
      ['x-from', 'polyfill'],
    ]);
    class PolyfillHeadersResponse extends Response {
      constructor() {
        super('polyfill-body', { status: 202 });
      }
      override get headers() {
        return headers as unknown as Headers;
      }
    }
    applicationState.current = () => new PolyfillHeadersResponse();
    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(202);
    const encoded = outgoing.headers as { entries: Array<[string, Uint8Array]> };
    expect(encoded.entries.map(([name, value]) => [name, new TextDecoder().decode(value)])).toEqual(
      [
        ['content-type', 'text/plain'],
        ['x-from', 'polyfill'],
      ],
    );
  });

  it('returns a JSON 500 when the application export is not a Response', async () => {
    applicationState.current = () => 'not-a-response' as unknown as Response;
    const outgoing = (await handler.handle(incoming({ method: { tag: 'head' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(500);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(collected)))).toEqual({
      error: 'Internal server error',
    });
  });

  it('lowers trailers and consume-body through wit.Future when qjs is present', async () => {
    const written: unknown[] = [];
    const trailersReadable = { kind: 'trailers' };
    const consumeReadable = { kind: 'consume' };
    const Future = Object.assign(
      (type: unknown) => {
        const readable = type === 'trailers-type' ? trailersReadable : consumeReadable;
        return {
          readable,
          writable: {
            write(value: unknown) {
              written.push({ type, value });
            },
          },
        };
      },
      {
        RESULT_OPTION_OTHER_ERROR_CODE: 'trailers-type',
        RESULT_VOID_ERROR_CODE: 'void-type',
      },
    );
    (globalThis as { wit?: unknown }).wit = { Future };

    const captured: unknown[] = [];
    wasiState.consumeBody = (_request, res) => {
      captured.push(res);
      return [readable(new TextEncoder().encode('payload'))];
    };

    const getOutgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(getOutgoing.trailers).toBe(trailersReadable);

    const postOutgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/body' }),
    )) as Outgoing;
    expect(captured).toEqual([consumeReadable]);
    expect(postOutgoing.statusCode).toBe(200);
    expect(written).toEqual([
      { type: 'trailers-type', value: { tag: 'ok', val: null } },
      { type: 'void-type', value: { tag: 'ok', val: undefined } },
      { type: 'trailers-type', value: { tag: 'ok', val: null } },
    ]);
  });

  it('rejects a missing guests object', () => {
    expect(() => requireGuestsObject(null)).toThrow(TypeError);
    expect(() => requireGuestsObject('guests')).toThrow(
      'wasmCloud guests module must export a guests object',
    );
    expect(() => requireGuestsObject({})).not.toThrow();
  });

  it('picks a non-preferred wit.Future type and falls back when none remain', async () => {
    const written: unknown[] = [];
    const fallbackReadable = { kind: 'fallback' };
    const FutureWithFallback = Object.assign(
      (type: unknown) => ({
        readable: type === 'custom-type' ? fallbackReadable : { kind: 'other', type },
        writable: {
          write(value: unknown) {
            written.push({ type, value });
          },
        },
      }),
      { types: true, from: true, CUSTOM: 'custom-type' },
    );
    (globalThis as { wit?: unknown }).wit = { Future: FutureWithFallback };

    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.trailers).toBe(fallbackReadable);
    expect(written).toEqual([{ type: 'custom-type', value: { tag: 'ok', val: null } }]);

    const FutureEmpty = Object.assign(
      (type: unknown) => ({
        readable: { kind: 'empty', type },
        writable: {
          write(value: unknown) {
            written.push({ type, value });
          },
        },
      }),
      { types: true, from: true },
    );
    (globalThis as { wit?: unknown }).wit = { Future: FutureEmpty };
    const emptyOutgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(emptyOutgoing.trailers).toEqual({ kind: 'empty', type: undefined });
  });
});
