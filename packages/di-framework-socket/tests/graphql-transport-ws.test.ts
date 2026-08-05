import { afterEach, describe, expect, it } from 'bun:test';
import { createGraphqlTransportWs } from '../graphql.ts';

const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const s of stoppers.splice(0)) s();
});

describe('createGraphqlTransportWs', () => {
  it('serves connection_init, query, and subscription streams over Bun WebSocket', async () => {
    type Ctx = { user?: string };
    const events: Array<{ user: string; msg: string }> = [];
    const listeners = new Set<(e: { user: string; msg: string }) => void>();

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

    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}`,
      'graphql-transport-ws',
    );
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
    void listeners;
  });

  it('closes on invalid JSON with 4400', async () => {
    const gtw = createGraphqlTransportWs({
      execute: async () => ({ data: null }),
      subscribe: async () => ({ errors: [{ message: 'nope' }] }),
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
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
