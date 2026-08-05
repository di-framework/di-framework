import { describe, expect, it } from 'bun:test';
import {
  SecureSession,
  createMemoryDuplexPair,
  textFrame,
  type SecureSessionSnapshot,
} from '../index.ts';
import {
  HibernatableSocketHub,
  type DurableObjectStateLike,
  type HibernatableAttachment,
  type HibernatableWebSocket,
} from '../workers.ts';

describe('HibernatableSocketHub secure rehydrate', () => {
  it('restoreFromHibernation rebuilds a session from attachment snapshot', async () => {
    // Real handshake offline to produce a valid snapshot pair
    const pair = createMemoryDuplexPair();
    const [provider, consumer] = await Promise.all([
      SecureSession.connect({ role: 'provider', duplex: pair.left }),
      SecureSession.connect({ role: 'consumer', duplex: pair.right }),
    ]);
    const serverSnap = provider.exportSnapshot();
    const clientSnap = consumer.exportSnapshot();
    provider.close({ closeTransport: false });
    consumer.close({ closeTransport: false });

    const sockets: HibernatableWebSocket[] = [];
    let attachment: HibernatableAttachment = {
      v: 1,
      security: 'secure',
      snapshot: serverSnap,
    };

    const ws: HibernatableWebSocket = {
      send() {},
      close() {},
      serializeAttachment(v) {
        attachment = v as HibernatableAttachment;
      },
      deserializeAttachment: () => attachment,
    };
    sockets.push(ws);

    const state: DurableObjectStateLike = {
      acceptWebSocket() {},
      getWebSockets() {
        return sockets;
      },
    };

    let connected = 0;
    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'secure' },
      onHibernate: 'rehydrate',
      onConnection() {
        connected++;
      },
    });

    await hub.restoreFromHibernation();
    expect(connected).toBe(1);
    expect(hub.getConnection(ws)?.securityMode).toBe('secure');

    // Client rehydrates on its side (browser wouldn't; here we prove counters work)
    const pair2 = createMemoryDuplexPair();
    // Wire hub connection send/receive through memory pair for a round-trip is heavy;
    // exportSnapshot after restore should match counters from serverSnap.
    const conn = hub.getConnection(ws)!;
    // Send via connection — needs duplex linked. Instead verify live session export.
    const live = (hub as unknown as { live: Map<HibernatableWebSocket, { session?: SecureSession }> })
      .live.get(ws);
    expect(live?.session).toBeTruthy();
    const again: SecureSessionSnapshot = live!.session!.exportSnapshot();
    expect(again.sessionId).toBe(serverSnap.sessionId);
    expect(again.sendCounter).toBe(serverSnap.sendCounter);
    expect(again.recvCounter).toBe(serverSnap.recvCounter);
    void clientSnap;
    void pair2;
    void conn;
  });

  it('restoreFromHibernation with rehandshake closes the socket', async () => {
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
      getWebSockets() {
        return [ws];
      },
    };

    const hub = new HibernatableSocketHub(state, {
      security: { mode: 'secure' },
      onHibernate: 'rehandshake',
    });

    await hub.restoreFromHibernation();
    expect(closed).toBe(4001);
  });
});
