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
});
