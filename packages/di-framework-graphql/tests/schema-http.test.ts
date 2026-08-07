/**
 * HTTP-adjacent surface of `schema.ts` that isn't already exercised by
 * `handler.test.ts`: mounting on a router-like object, and the GraphQL-over-SSE
 * subscription endpoint (happy path, heartbeats, mid-stream errors, cancellation
 * and the non-iterable/validation-error fallback).
 */

import { describe, expect, it } from 'bun:test';
import { Field, Portal } from '../src/decorators.ts';
import {
  buildSemanticSchema,
  createGraphQLSSEHandler,
  type ExecuteRequest,
  mountGraphQL,
  type SemanticSchema,
} from '../src/schema.ts';
import { withRegistry } from './helpers.ts';

function fakeIterable(
  items: unknown[],
  options: { rejectWith?: Error; onReturn?: () => void; delayMs?: number } = {},
) {
  let index = 0;
  let rejected = false;
  return {
    async next() {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (index < items.length) {
        return { value: items[index++], done: false };
      }
      if (options.rejectWith && !rejected) {
        rejected = true;
        throw options.rejectWith;
      }
      return { value: undefined, done: true };
    },
    async return() {
      options.onReturn?.();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function fakeApi(subscribeImpl: (request: ExecuteRequest) => unknown): SemanticSchema {
  return { subscribe: subscribeImpl } as unknown as SemanticSchema;
}

function fakeExecuteApi(executeImpl: (request: ExecuteRequest) => unknown): SemanticSchema {
  return { execute: executeImpl } as unknown as SemanticSchema;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('mountGraphQL', () => {
  it('registers both a GET and a POST route at the given path, and returns the router', () => {
    const calls: Array<{ method: string; path: string }> = [];
    const router = {
      get(path: string, _handler: unknown) {
        calls.push({ method: 'get', path });
        return router;
      },
      post(path: string, _handler: unknown) {
        calls.push({ method: 'post', path });
        return router;
      },
    };

    const api = fakeApi(async () => ({ data: {} }));
    const result = mountGraphQL(router, api, { path: '/gql' });

    expect(result).toBe(router);
    expect(calls).toEqual([
      { method: 'get', path: '/gql' },
      { method: 'post', path: '/gql' },
    ]);
  });

  it('defaults the path to /graphql and installs a working handler', async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const router = {
      get(_path: string, h: (request: Request) => Promise<Response>) {
        handler = h;
        return router;
      },
      post() {
        return router;
      },
    };

    const api = fakeExecuteApi(async () => ({ data: { ok: true } }));
    mountGraphQL(router, api);

    const response = await handler!(new Request('http://localhost/graphql?query={ok}'));
    expect(response.status).toBe(200);
  });
});

describe('createGraphQLSSEHandler', () => {
  it('rejects non-GET requests', async () => {
    const handler = createGraphQLSSEHandler(fakeApi(async () => fakeIterable([])));
    const response = await handler(new Request('http://localhost/sse', { method: 'POST' }));
    expect(response.status).toBe(405);
  });

  it('requires a query parameter', async () => {
    const handler = createGraphQLSSEHandler(fakeApi(async () => fakeIterable([])));
    const response = await handler(new Request('http://localhost/sse'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Missing "query" parameter');
  });

  it('streams each event and a final complete event', async () => {
    let receivedRequest: ExecuteRequest | undefined;
    const handler = createGraphQLSSEHandler(
      fakeApi((request) => {
        receivedRequest = request;
        return fakeIterable([{ data: { tick: 1 } }, { data: { tick: 2 } }]);
      }),
    );

    const response = await handler(
      new Request(
        'http://localhost/sse?query=' +
          encodeURIComponent('subscription { tick }') +
          '&variables=' +
          encodeURIComponent('{"a":1}') +
          '&operationName=Sub',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = await readAll(response.body!);
    expect(body).toContain('event: next\ndata: {"data":{"tick":1}}');
    expect(body).toContain('event: next\ndata: {"data":{"tick":2}}');
    expect(body).toContain('event: complete\ndata: {}');

    expect(receivedRequest).toMatchObject({
      query: 'subscription { tick }',
      variables: { a: 1 },
      operationName: 'Sub',
    });
  });

  it('builds the context from the request via the context option', async () => {
    let receivedRequest: ExecuteRequest | undefined;
    const handler = createGraphQLSSEHandler(
      fakeApi((request) => {
        receivedRequest = request;
        return fakeIterable([]);
      }),
      { context: (request) => ({ token: request.headers.get('x-token') }) },
    );

    await readAll(
      (
        await handler(
          new Request('http://localhost/sse?query={tick}', {
            headers: { 'x-token': 'abc' },
          }),
        )
      ).body!,
    );

    expect(receivedRequest?.context).toEqual({ token: 'abc' });
  });

  it('sends periodic heartbeat comments while the stream is open', async () => {
    const handler = createGraphQLSSEHandler(
      fakeApi(() => fakeIterable([{ data: {} }], { delayMs: 30 })),
      { heartbeatMs: 5 },
    );

    const response = await handler(new Request('http://localhost/sse?query={tick}'));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Read until we've seen at least one heartbeat or the stream closes.
    for (let i = 0; i < 50 && !text.includes('heartbeat'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      if (!text.includes('heartbeat')) await new Promise((r) => setTimeout(r, 5));
    }
    await reader.cancel();
    expect(text).toContain(': heartbeat');
  });

  it('emits an error event and closes when the source rejects mid-stream', async () => {
    const handler = createGraphQLSSEHandler(
      fakeApi(() => fakeIterable([{ data: { ok: true } }], { rejectWith: new Error('boom') })),
    );

    const response = await handler(new Request('http://localhost/sse?query={tick}'));
    const body = await readAll(response.body!);
    expect(body).toContain('event: next');
    expect(body).toContain('event: error');
    expect(body).toContain('boom');
  });

  it('calls iterator.return() when the client cancels the stream', async () => {
    let returned = false;
    const handler = createGraphQLSSEHandler(
      fakeApi(() =>
        fakeIterable([{ data: {} }, { data: {} }], { onReturn: () => (returned = true) }),
      ),
    );

    const response = await handler(new Request('http://localhost/sse?query={tick}'));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(returned).toBe(true);
  });

  it('returns validation errors as JSON when subscribe does not produce an iterator', async () => {
    const handler = createGraphQLSSEHandler(
      fakeApi(async () => ({ errors: [{ message: 'bad query' }] })),
    );

    const response = await handler(new Request('http://localhost/sse?query={bad}'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.errors[0].message).toBe('bad query');
  });
});

describe('buildSemanticSchema errorFormatter', () => {
  function buildFormattedApi() {
    return withRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        boom(): string {
          throw new Error('kaboom');
        }
      }

      return buildSemanticSchema({
        registry,
        errorFormatter: (error) =>
          Object.assign(Object.create(Object.getPrototypeOf(error)), error, {
            message: `formatted: ${error.message}`,
          }),
      });
    });
  }

  it('rewrites validation errors returned from execute()', async () => {
    const api = buildFormattedApi();
    const result = await api.execute({ query: '{ nope }' });
    expect(result.errors?.[0]?.message).toMatch(/^formatted: /);
  });

  it('rewrites execution errors surfaced by formatResult after a successful run', async () => {
    const api = buildFormattedApi();
    const result = await api.execute({ query: '{ boom }' });
    expect(result.errors?.[0]?.message).toBe('formatted: kaboom');
  });

  it('rewrites validation errors returned from subscribe()', async () => {
    const api = buildFormattedApi();
    const result = await api.subscribe({ query: '{ nope }' });
    expect((result as any).errors?.[0]?.message).toMatch(/^formatted: /);
  });

  it('leaves successful results untouched', async () => {
    const api = withRegistry((registry) => {
      @Portal()
      class Query {
        @Field(() => String)
        hello(): string {
          return 'hi';
        }
      }
      return buildSemanticSchema({
        registry,
        errorFormatter: (error) => error,
      });
    });
    const result = await api.execute({ query: '{ hello }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ hello: 'hi' });
  });
});
