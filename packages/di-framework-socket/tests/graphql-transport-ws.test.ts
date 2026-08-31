import { afterEach, describe, expect, it } from 'bun:test';
import { connectionParamsToHeaders, createGraphqlTransportWs } from '../graphql.ts';

const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const s of stoppers.splice(0)) s();
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('createGraphqlTransportWs', () => {
  it('serves connection_init, query, and subscription streams over Bun WebSocket', async () => {
    type Ctx = { user?: string };
    const events: Array<{ user: string; msg: string }> = [];

    const gtw = createGraphqlTransportWs<Ctx>({
      initialContext: () => ({}),
      contextFromConnectionInit: (payload) => ({
        user: String((payload as { user?: string })?.user ?? 'anon'),
      }),
      execute: async ({ query, context }) => {
        if (query.includes('hello')) {
          return { data: { hello: `hi ${(context as Ctx).user}` } };
        }
        return { data: null, errors: [{ message: 'unknown' }] };
      },
      subscribe: async ({ context }) => {
        const user = (context as Ctx).user ?? 'anon';
        async function* gen() {
          const event = { user, msg: 'tick' };
          events.push(event);
          yield { data: { onMessage: event } };
        }
        return gen();
      },
    });

    const server = Bun.serve({
      port: 0,
      websocket: gtw.websocket,
      fetch(req, srv) {
        if (req.headers.get('upgrade') === 'websocket') {
          const ok = srv.upgrade(req, {
            headers: { 'Sec-WebSocket-Protocol': gtw.subprotocol },
            data: gtw.createData(),
          });
          return ok ? undefined : new Response('fail', { status: 400 });
        }
        return new Response('ok');
      },
    });
    stoppers.push(() => server.stop(true));

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, 'graphql-transport-ws');
    const inbox: any[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws error')));
    });
    socket.addEventListener('message', (ev) => inbox.push(JSON.parse(String(ev.data))));

    socket.send(JSON.stringify({ type: 'connection_init', payload: { user: 'alice' } }));
    await waitFor(() => inbox.some((m) => m.type === 'connection_ack'));

    socket.send(
      JSON.stringify({
        id: 'q1',
        type: 'subscribe',
        payload: { query: 'query { hello }' },
      }),
    );
    await waitFor(() => inbox.some((m) => m.id === 'q1' && m.type === 'next'));
    const next = inbox.find((m) => m.id === 'q1' && m.type === 'next');
    expect(next.payload.data.hello).toBe('hi alice');
    await waitFor(() => inbox.some((m) => m.id === 'q1' && m.type === 'complete'));

    socket.send(
      JSON.stringify({
        id: 's1',
        type: 'subscribe',
        payload: { query: 'subscription { onMessage { msg } }' },
      }),
    );
    await waitFor(() => inbox.some((m) => m.id === 's1' && m.type === 'next'));
    expect(events[0]?.user).toBe('alice');

    socket.close();
  });

  it('closes on invalid JSON with 4400', async () => {
    const gtw = createGraphqlTransportWs({
      execute: async () => ({ data: null }),
      subscribe: async () => ({ errors: [{ message: 'noop' }] }),
    });

    const server = Bun.serve({
      port: 0,
      websocket: gtw.websocket,
      fetch(req, srv) {
        if (req.headers.get('upgrade') === 'websocket') {
          srv.upgrade(req, { data: gtw.createData() });
          return undefined;
        }
        return new Response('ok');
      },
    });
    stoppers.push(() => server.stop(true));

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws error')));
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener('close', (ev) => resolve(ev.code)),
    );
    socket.send('not-json');
    expect(await closed).toBe(4400);
  });

  it('closes subscribe without id with 4400 (no "undefined" collision)', async () => {
    const gtw = createGraphqlTransportWs({
      execute: async () => ({ data: { ok: true } }),
      subscribe: async () => ({ errors: [{ message: 'noop' }] }),
    });

    const data = gtw.createData({ acknowledged: true });
    let closed: { code?: number; reason?: string } | undefined;
    gtw.handleMessage(
      () => {},
      data,
      JSON.stringify({ type: 'subscribe', payload: { query: 'query { hello }' } }),
      (code, reason) => {
        closed = { code, reason };
      },
    );
    expect(closed?.code).toBe(4400);
    expect(data.operations.has('undefined')).toBe(false);
    expect(data.operations.size).toBe(0);
  });

  it('covers named ops, ping/pong, complete, errors, and auth via handleMessage', async () => {
    const gtw = createGraphqlTransportWs({
      initialContext: { base: true },
      execute: async () => ({ data: { q: 1 } }),
      subscribe: async ({ query }) => {
        if (query.includes('fail-iter')) {
          return { errors: [{ message: 'no-stream' }] };
        }
        if (query.includes('throw-iter')) {
          async function* boom() {
            yield { data: { x: 1 } };
            throw new Error('iter-boom');
          }
          return boom();
        }
        async function* gen() {
          yield { data: { x: 1 } };
        }
        return gen();
      },
    });

    const inbox: any[] = [];
    const send = (m: unknown) => inbox.push(typeof m === 'string' ? JSON.parse(m as string) : m);
    let closed: { code?: number; reason?: string } | undefined;
    const close = (code?: number, reason?: string) => {
      closed = { code, reason };
    };
    const data = gtw.createData();

    gtw.handleMessage(
      send,
      data,
      JSON.stringify({ type: 'connection_init', payload: { user: 'u' } }),
      close,
    );
    await Bun.sleep(10);
    expect(inbox.some((m) => m.type === 'connection_ack')).toBe(true);

    gtw.handleMessage(send, data, JSON.stringify({ type: 'ping' }), close);
    expect(inbox.some((m) => m.type === 'pong')).toBe(true);
    gtw.handleMessage(send, data, JSON.stringify({ type: 'pong' }), close);

    gtw.handleMessage(
      send,
      data,
      JSON.stringify({
        id: '1',
        type: 'subscribe',
        payload: { query: 'subscription Feed { x }', operationName: 'Feed' },
      }),
      close,
    );
    await waitFor(() => inbox.some((m) => m.id === '1' && m.type === 'next'));
    gtw.handleMessage(send, data, JSON.stringify({ id: '1', type: 'complete' }), close);

    gtw.handleMessage(
      send,
      data,
      JSON.stringify({
        id: '2',
        type: 'subscribe',
        payload: { query: 'subscription { fail-iter }' },
      }),
      close,
    );
    await waitFor(() => inbox.some((m) => m.id === '2' && m.type === 'error'));

    gtw.handleMessage(
      send,
      data,
      JSON.stringify({
        id: '3',
        type: 'subscribe',
        payload: { query: 'subscription { throw-iter }' },
      }),
      close,
    );
    await waitFor(() => inbox.some((m) => m.id === '3' && m.type === 'error'));

    const data2 = gtw.createData({ acknowledged: false });
    gtw.handleMessage(
      send,
      data2,
      JSON.stringify({ id: 'x', type: 'subscribe', payload: { query: '{ a }' } }),
      close,
    );
    expect(closed?.code).toBe(4401);

    gtw.handleMessage(send, data, JSON.stringify({ type: 'noop' }), close);
    expect(closed?.code).toBe(4400);

    const before = inbox.length;
    gtw.handleMessage(
      send,
      data,
      JSON.stringify({ id: '4', type: 'subscribe', payload: { query: '{ hello }' } }),
      close,
    );
    await waitFor(() => inbox.length > before);

    // startOperation .catch path: execute throws
    const gtwThrow = createGraphqlTransportWs({
      execute: async () => {
        throw new Error('exec-fail');
      },
      subscribe: async () => ({ errors: [{ message: 'x' }] }),
    });
    const d3 = gtwThrow.createData({ acknowledged: true });
    const inbox3: any[] = [];
    gtwThrow.handleMessage(
      (m) => inbox3.push(typeof m === 'string' ? JSON.parse(m) : m),
      d3,
      JSON.stringify({ id: 'e', type: 'subscribe', payload: { query: '{ x }' } }),
    );
    await waitFor(() => inbox3.some((m) => m.type === 'error'));

    const gtwAuth = createGraphqlTransportWs({
      execute: async () => ({ data: null }),
      subscribe: async () => ({ errors: [{ message: 'x' }] }),
      contextFromConnectionInit: async () => {
        throw 'denied';
      },
    });
    let authClosed: number | undefined;
    gtwAuth.handleMessage(
      () => {},
      gtwAuth.createData(),
      JSON.stringify({ type: 'connection_init', payload: {} }),
      (code) => {
        authClosed = code;
      },
    );
    await Bun.sleep(10);
    expect(authClosed).toBe(4403);

    gtw.handleMessage(send, data, JSON.stringify({ id: 9, type: 'complete' }), close);
    gtw.handleClose(data);
  });

  it('connectionParamsToHeaders maps authorization, token, cookie, and apiKey', () => {
    expect(connectionParamsToHeaders(null).has('authorization')).toBe(false);

    expect(connectionParamsToHeaders({ authorization: 'Bearer a' }).get('authorization')).toBe(
      'Bearer a',
    );
    expect(connectionParamsToHeaders({ token: 't' }).get('authorization')).toBe('Bearer t');
    expect(connectionParamsToHeaders({ cookie: 'a=1', apiKey: 'k' }).get('cookie')).toBe('a=1');
    expect(connectionParamsToHeaders({ cookie: 'a=1', apiKey: 'k' }).get('x-api-key')).toBe('k');

    const d = connectionParamsToHeaders({
      Authorization: 'Bearer A',
      Cookie: 'b=2',
      'x-api-key': 'z',
    });
    expect(d.get('authorization')).toBe('Bearer A');
    expect(d.get('cookie')).toBe('b=2');
    expect(d.get('x-api-key')).toBe('z');
  });
});
