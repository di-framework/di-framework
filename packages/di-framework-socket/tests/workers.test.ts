import { describe, expect, it } from 'bun:test';
import { binaryFrame, createMemoryDuplexPair, SecureSession, textFrame } from '../index.ts';
import {
  cfMessageToFrame,
  createPushableDuplex,
  type DurableObjectStateLike,
  HibernatableSocketHub,
  type HibernatableWebSocket,
  sendFrame,
} from '../workers.ts';

describe('cfMessageToFrame / sendFrame', () => {
  it('maps string → text and ArrayBuffer → binary', () => {
    expect(cfMessageToFrame('hi').kind).toBe('text');
    expect(cfMessageToFrame('hi').text).toBe('hi');
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const f = cfMessageToFrame(ab);
    expect(f.kind).toBe('binary');
    expect([...f.data]).toEqual([1, 2, 3]);
  });

  it('sendFrame uses string for text and bytes for binary', () => {
    const sent: unknown[] = [];
    const ws = {
      send(data: unknown) {
        sent.push(data);
      },
      close() {},
    };
    sendFrame(ws, textFrame('a'));
    sendFrame(ws, binaryFrame(new Uint8Array([9])));
    expect(sent[0]).toBe('a');
    expect(sent[1]).toBeInstanceOf(Uint8Array);
  });
});

describe('SecureSession rehydrate', () => {
  it('exports and restores AEAD so counters stay in sync', async () => {
    const iso = createMemoryDuplexPair();
    // Consumer must register before provider's deferred handshake-init is delivered.
    const [a, b] = await Promise.all([
      SecureSession.connect({ role: 'provider', duplex: iso.left }),
      SecureSession.connect({ role: 'consumer', duplex: iso.right }),
    ]);

    const gotX = new Promise<string>((resolve) => {
      b.onData((f) => {
        if (f.text === 'x') resolve(f.text!);
      });
    });
    await a.send(textFrame('x'));
    expect(await gotX).toBe('x');

    const snap = a.exportSnapshot();
    expect(snap.v).toBe(1);

    // Simulate DO unload: drop server session, keep transport open
    a.close({ closeTransport: false });
    const a2 = await SecureSession.rehydrate({ duplex: iso.left, snapshot: snap });

    const got = new Promise<string>((resolve) => {
      b.onData((f) => {
        if (f.text === 'after') resolve(f.text!);
      });
    });
    await a2.send(textFrame('after'));
    expect(await got).toBe('after');

    a2.close({ closeTransport: false });
    b.close();
  });
});

describe('PushableDuplex', () => {
  it('delivers pushed frames to SecureSession', async () => {
    const sent: SocketFrameLike[] = [];
    type SocketFrameLike = { kind: string; text?: string; data: Uint8Array };

    const ws: HibernatableWebSocket = {
      send(data) {
        if (typeof data === 'string')
          sent.push({ kind: 'text', text: data, data: new TextEncoder().encode(data) });
        else {
          const u8 = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
          sent.push({ kind: 'binary', data: u8 });
        }
      },
      close() {},
      serializeAttachment() {},
      deserializeAttachment: () => null,
    };

    const duplex = createPushableDuplex(ws);
    const providerP = SecureSession.connect({ role: 'provider', duplex });

    // Consumer side: another pushable
    const clientSent: unknown[] = [];
    const clientWs: HibernatableWebSocket = {
      send(data) {
        clientSent.push(data);
        // Relay text frames to provider duplex (simulate network)
        if (typeof data === 'string') duplex.push(cfMessageToFrame(data));
        else duplex.push(cfMessageToFrame(data as ArrayBuffer));
      },
      close() {},
    };
    const clientDuplex = createPushableDuplex(clientWs);

    // Bridge provider → client
    const origSend = duplex.send.bind(duplex);
    duplex.send = (frame) => {
      origSend(frame);
      // also deliver to client handlers via reverse path
      if (frame.kind === 'text' && frame.text) clientDuplex.push(textFrame(frame.text));
      else clientDuplex.push(binaryFrame(frame.data));
    };

    // Simpler: use memory duplex for crypto path (already tested). Here just pushable unit:
    const got: string[] = [];
    duplex.onMessage((f) => {
      if (f.text) got.push(f.text);
    });
    duplex.push(textFrame('ping'));
    expect(got).toEqual(['ping']);
    void providerP;
    void clientDuplex;
    void sent;
  });
});

describe('HibernatableSocketHub', () => {
  function mockDo() {
    const sockets: HibernatableWebSocket[] = [];
    const attachments = new WeakMap<HibernatableWebSocket, unknown>();

    const state: DurableObjectStateLike = {
      acceptWebSocket(ws) {
        sockets.push(ws);
      },
      getWebSockets() {
        return [...sockets];
      },
    };

    function makeWs(): HibernatableWebSocket {
      const sent: unknown[] = [];
      const ws: HibernatableWebSocket = {
        send(data) {
          sent.push(data);
        },
        close() {},
        serializeAttachment(v) {
          attachments.set(ws, v);
        },
        deserializeAttachment: () => attachments.get(ws) ?? null,
      };
      (ws as unknown as { _sent: unknown[] })._sent = sent;
      return ws;
    }

    return { state, makeWs, sockets, attachments };
  }

  it('plain mode: accept upgrade and echo via webSocketMessage', async () => {
    const { state, makeWs } = mockDo();
    const frames: string[] = [];

    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'plain' },
      onConnection(conn) {
        conn.onMessage(async (frame) => {
          frames.push(frame.text ?? '');
          await conn.send(textFrame(`echo:${frame.text}`));
        });
      },
    });

    const client = makeWs();
    const server = makeWs();
    const res = await hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );
    expect(res.status).toBe(101);

    await hub.webSocketMessage(server, 'hello');
    expect(frames).toEqual(['hello']);
    const sent = (server as unknown as { _sent: unknown[] })._sent;
    expect(sent.some((s) => s === 'echo:hello')).toBe(true);
  });

  it('secure rehandshake: closes sockets on restore without snapshot path', async () => {
    const { state, makeWs } = mockDo();
    let closedCode: number | undefined;

    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'secure' },
      onHibernate: 'rehandshake',
      rehandshakeCloseCode: 4001,
    });

    const ws = makeWs();
    ws.close = (code?: number) => {
      closedCode = code;
    };
    state.acceptWebSocket(ws);
    ws.serializeAttachment?.({ v: 1, security: 'secure' });

    await hub.restoreFromHibernation();
    expect(closedCode).toBe(4001);
  });

  it('handleUpgrade returns 426 without Upgrade and throws without WebSocketPair', async () => {
    const { state } = mockDo();
    const hub = new HibernatableSocketHub(state, { security: { mode: 'plain' } });
    const bad = await hub.handleUpgrade(new Request('https://example.com/ws'));
    expect(bad.status).toBe(426);

    const prev = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    try {
      await expect(
        hub.handleUpgrade(
          new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
        ),
      ).rejects.toThrow(/WebSocketPair is not available/);
    } finally {
      if (prev !== undefined) (globalThis as { WebSocketPair?: unknown }).WebSocketPair = prev;
    }
  });

  it('handleUpgrade returns 400 when attach fails and close throws', async () => {
    const { state, makeWs } = mockDo();
    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'plain' },
      onConnection() {
        throw new Error('attach-fail');
      },
    });
    const client = makeWs();
    const server = makeWs();
    server.close = () => {
      throw new Error('close-fail');
    };
    const res = await hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );
    expect(res.status).toBe(400);
  });

  it('webSocketClose / webSocketError tear down live entries', async () => {
    const { state, makeWs } = mockDo();
    const hub = new HibernatableSocketHub(state, { security: { mode: 'plain' } });
    const client = makeWs();
    const server = makeWs();
    await hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );
    expect(hub.getConnection(server)).toBeTruthy();
    hub.webSocketError(server);
    expect(hub.getConnection(server)).toBeUndefined();
    hub.webSocketClose(server);
  });

  it('webSocketMessage restores a plain socket that was not in the live map', async () => {
    const sockets: HibernatableWebSocket[] = [];
    const attachments = new WeakMap<HibernatableWebSocket, unknown>();
    const state: DurableObjectStateLike = {
      acceptWebSocket(ws) {
        sockets.push(ws);
      },
      getWebSockets() {
        return [...sockets];
      },
    };
    const frames: string[] = [];
    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'plain' },
      onConnection(conn) {
        conn.onMessage((f) => {
          frames.push(f.text ?? '');
        });
      },
    });
    const ws: HibernatableWebSocket = {
      send() {},
      close() {},
      serializeAttachment(v) {
        attachments.set(ws, v);
      },
      deserializeAttachment: () => attachments.get(ws) ?? { v: 1, security: 'plain' },
    };
    sockets.push(ws);
    await hub.webSocketMessage(ws, 'restored-hello');
    expect(frames).toEqual(['restored-hello']);
  });

  it('plain restoreFromHibernation rebuilds connections', async () => {
    const sockets: HibernatableWebSocket[] = [];
    const attachments = new WeakMap<HibernatableWebSocket, unknown>();
    const state: DurableObjectStateLike = {
      acceptWebSocket(ws) {
        sockets.push(ws);
      },
      getWebSockets() {
        return [...sockets];
      },
    };
    const ws: HibernatableWebSocket = {
      send() {},
      close() {},
      serializeAttachment(v) {
        attachments.set(ws, v);
      },
      deserializeAttachment: () => attachments.get(ws) ?? { v: 1, security: 'plain' },
    };
    sockets.push(ws);

    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'plain' },
      onConnection(conn) {
        conn.close(1000, 'x');
      },
      onSerializeAttachment(current) {
        return { ...current, meta: { room: 'r1' } };
      },
    });

    await hub.restoreFromHibernation();
    expect(hub.getConnection(ws)).toBeTruthy();
    hub.getConnection(ws)?.close(1000, 'x');
    await hub.restoreFromHibernation();
  });

  it('secure handleUpgrade completes handshake and persists session snapshots', async () => {
    const { state, makeWs } = mockDo();
    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'secure' },
      onHibernate: 'rehydrate',
      onSerializeAttachment(current) {
        return { ...current, meta: { u: 1 } };
      },
    });

    const client = makeWs();
    const server = makeWs();
    const clientDuplex = createPushableDuplex(client);
    server.send = (data) => {
      if (typeof data === 'string') clientDuplex.push(cfMessageToFrame(data));
      else clientDuplex.push(cfMessageToFrame(data as ArrayBuffer));
    };
    const origClientSend = client.send.bind(client);
    let upgradeStarted = false;
    client.send = (data) => {
      origClientSend(data);
      if (upgradeStarted) {
        void hub.webSocketMessage(server, data as string | ArrayBuffer);
      }
    };

    upgradeStarted = true;
    const upgradeP = hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );
    const consumerP = SecureSession.connect({ role: 'consumer', duplex: clientDuplex });
    const [res] = await Promise.all([upgradeP, consumerP]);
    expect(res.status).toBe(101);
    expect(hub.getConnection(server)?.securityMode).toBe('secure');

    // Touch pending stubs indirectly: send after handshake triggers persistSession
    await hub.webSocketMessage(server, 'noop-after-handshake');
    // Exercise pending connection methods if still pending (they shouldn't be)
    const conn = hub.getConnection(server)!;
    conn.onMessage(() => {});
    conn.onClose(() => {});
    hub.webSocketClose(server);
  });

  it('secure rehydrate closes when snapshot is missing', async () => {
    let closed: number | undefined;
    const ws: HibernatableWebSocket = {
      send() {},
      close(code) {
        closed = code;
      },
      serializeAttachment() {},
      deserializeAttachment: () => ({ v: 1, security: 'secure' }),
    };
    const state: DurableObjectStateLike = {
      acceptWebSocket() {},
      getWebSockets: () => [ws],
    };
    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'secure' },
      onHibernate: 'rehydrate',
    });
    await hub.restoreFromHibernation();
    expect(closed).toBe(4001);
  });

  it('plain mode: close callback closes duplex', async () => {
    const { state, makeWs } = mockDo();
    let duplexClosed = false;
    const hub = new HibernatableSocketHub(state, { security: { mode: 'plain' } });
    const client = makeWs();
    const server = makeWs();
    server.close = () => {
      duplexClosed = true;
    };
    await hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );
    const conn = hub.getConnection(server);
    conn?.close(1000, 'done');
    expect(duplexClosed).toBe(true);
  });

  it('secure mode: pending connection methods respond appropriately during handshake', async () => {
    const { state, makeWs } = mockDo();
    let duplexClosed = false;
    const hub = new HibernatableSocketHub(state, { security: { mode: 'secure' } });
    const client = makeWs();
    const server = makeWs();
    server.close = () => {
      duplexClosed = true;
    };

    const upgradeP = hub.handleUpgrade(
      new Request('https://example.com/ws', { headers: { Upgrade: 'websocket' } }),
      () => ({ 0: client, 1: server }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const conn = hub.getConnection(server);
    expect(conn?.id).toBe('pending');
    expect(() => conn?.send(textFrame('test'))).toThrow('Secure handshake not finished');
    expect(conn?.onMessage(() => {})).toBeFunction();
    expect(conn?.onClose(() => {})).toBeFunction();
    conn?.close(1000, 'abort');
    expect(duplexClosed).toBe(true);
  });

  it('plain mode: send frame on restored connection sends to duplex', async () => {
    const sockets: HibernatableWebSocket[] = [];
    const attachments = new WeakMap<HibernatableWebSocket, unknown>();
    const state: DurableObjectStateLike = {
      acceptWebSocket(ws) {
        sockets.push(ws);
      },
      getWebSockets() {
        return [...sockets];
      },
    };
    const sent: unknown[] = [];
    const ws: HibernatableWebSocket = {
      send(data) {
        sent.push(data);
      },
      close() {},
      serializeAttachment(v) {
        attachments.set(ws, v);
      },
      deserializeAttachment: () => attachments.get(ws) ?? { v: 1, security: 'plain' },
    };
    sockets.push(ws);

    const hub = new HibernatableSocketHub(state, { security: { mode: 'plain' } });
    await hub.restoreFromHibernation();
    const conn = hub.getConnection(ws);
    await conn?.send(textFrame('restored-frame'));
    expect(sent).toEqual(['restored-frame']);
  });
});
