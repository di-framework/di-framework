import { describe, expect, it } from 'bun:test';
import { SecureSession, type SocketConnection, textFrame } from '../index.ts';
import {
  cfMessageToFrame,
  createPushableDuplex,
  createWorkerWebSocketUpgrade,
  duplexFromWebSocket,
  type HibernatableWebSocket,
} from '../workers.ts';

function mockWs(opts: { closeThrows?: boolean } = {}) {
  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();
  const ws: HibernatableWebSocket & {
    accept?: () => void;
    _sent: unknown[];
    _emit: (type: string, data?: unknown) => void;
  } = {
    _sent: sent,
    send(data) {
      sent.push(data);
    },
    close() {
      if (opts.closeThrows) throw new Error('already closed');
    },
    serializeAttachment() {},
    deserializeAttachment: () => null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    _emit(type, data) {
      for (const l of listeners.get(type) ?? []) l({ data });
    },
  };
  return ws;
}

describe('cfMessageToFrame ArrayBufferView branch', () => {
  it('maps a DataView to a binary frame', () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const view = new DataView(buf, 1, 2);
    const frame = cfMessageToFrame(view);
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([2, 3]);
  });

  it('throws for unsupported message types', () => {
    expect(() => cfMessageToFrame(123 as never)).toThrow(/expected string/);
  });
});

describe('createPushableDuplex lifecycle', () => {
  it('exposes closed, ignores traffic after close, and swallows close errors', () => {
    const ws = mockWs({ closeThrows: true });
    const duplex = createPushableDuplex(ws);
    expect(duplex.closed).toBe(false);

    const got: string[] = [];
    const off = duplex.onMessage((f) => {
      if (f.text) got.push(f.text);
    });
    duplex.push(textFrame('a'));
    expect(got).toEqual(['a']);
    off();

    duplex.close?.(1000, 'bye');
    expect(duplex.closed).toBe(true);
    duplex.push(textFrame('ignored'));
    duplex.send(textFrame('ignored'));
    duplex.close?.(1000, 'again');
  });
});

describe('duplexFromWebSocket', () => {
  it('delivers messages and supports send/close/dispose', () => {
    const ws = mockWs();
    const duplex = duplexFromWebSocket(ws);
    const got: string[] = [];
    duplex.onMessage((f) => {
      if (f.text) got.push(f.text);
    });

    ws._emit('message', 'hello');
    ws._emit('message', undefined);
    ws._emit('message', 42);
    expect(got).toEqual(['hello']);

    duplex.send(textFrame('out'));
    expect(ws._sent).toContain('out');

    duplex.close?.(1000, 'done');
    duplex.send(textFrame('after'));
    duplex.close?.();

    const ws2 = mockWs({ closeThrows: true });
    const d2 = duplexFromWebSocket(ws2);
    d2.dispose();
    d2.close?.(1000, 'x');
  });
});

describe('createWorkerWebSocketUpgrade', () => {
  it('returns 426 when Upgrade header is missing', async () => {
    const res = await createWorkerWebSocketUpgrade(new Request('https://example.com/ws'));
    expect(res.status).toBe(426);
  });

  it('throws when WebSocketPair is unavailable and no createPair is provided', async () => {
    const prev = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    try {
      await expect(
        createWorkerWebSocketUpgrade(
          new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
        ),
      ).rejects.toThrow(/WebSocketPair is not available/);
    } finally {
      if (prev !== undefined) (globalThis as { WebSocketPair?: unknown }).WebSocketPair = prev;
    }
  });

  it('accepts plain mode with accept() on the server end', async () => {
    const client = mockWs();
    const server = mockWs();
    let accepted = false;
    server.accept = () => {
      accepted = true;
    };

    let connected = false;
    let connRef: SocketConnection | undefined;
    const res = await createWorkerWebSocketUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'WebSocket' } }),
      {
        security: { mode: 'plain' },
        createPair: () => ({ 0: client, 1: server }),
        onConnection(conn) {
          connected = true;
          connRef = conn;
        },
      },
    );
    expect(res.status).toBe(101);
    expect(accepted).toBe(true);
    expect(connected).toBe(true);

    // Exercise plain send/close callbacks wired into the duplex
    await connRef?.send(textFrame('ping'));
    expect(server._sent).toContain('ping');
    connRef?.close(1000, 'done');
  });

  it('falls back to client.accept() when server has no accept', async () => {
    const client = mockWs();
    const server = mockWs();
    let accepted = false;
    client.accept = () => {
      accepted = true;
    };

    const res = await createWorkerWebSocketUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      {
        security: { mode: 'plain' },
        createPair: () => ({ 0: client, 1: server }),
      },
    );
    expect(res.status).toBe(101);
    expect(accepted).toBe(true);
  });

  it('returns 400 when onConnection throws (and swallows close errors)', async () => {
    const client = mockWs();
    const server = mockWs({ closeThrows: true });
    server.accept = () => {};

    const res = await createWorkerWebSocketUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      {
        security: { mode: 'plain' },
        createPair: () => ({ 0: client, 1: server }),
        onConnection() {
          throw new Error('boom');
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it('completes a secure upgrade when a consumer answers on the duplex', async () => {
    const client = mockWs();
    const server = mockWs();
    server.accept = () => {};

    // Bridge server.send → consumer pushable; consumer.send → server message events.
    const consumerDuplex = createPushableDuplex(client);
    server.send = (data) => {
      if (typeof data === 'string') consumerDuplex.push(cfMessageToFrame(data));
      else consumerDuplex.push(cfMessageToFrame(data as ArrayBuffer));
    };
    const origClientSend = client.send.bind(client);
    client.send = (data) => {
      origClientSend(data);
      server._emit('message', data);
    };

    const upgradeP = createWorkerWebSocketUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      {
        security: { mode: 'secure' },
        createPair: () => ({ 0: client, 1: server }),
      },
    );
    const consumerP = SecureSession.connect({ role: 'consumer', duplex: consumerDuplex });
    const [res] = await Promise.all([upgradeP, consumerP]);
    expect(res.status).toBe(101);
  });
});
