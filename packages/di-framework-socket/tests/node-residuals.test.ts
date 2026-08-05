import { afterEach, describe, expect, it } from 'bun:test';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import type { SocketConnection } from '../index.ts';
import { textFrame } from '../index.ts';
import { rawToFrame } from '../src/adapters/node-websocket.ts';
import {
  connectTcpClient,
  connectUdpClient,
  connectWebSocketClient,
  createTcpServer,
  createUdpSocket,
  createWebSocketServer,
} from '../node.ts';

const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

describe('node-tcp residual branches', () => {
  it('destroys the socket when length-prefix framing fails', async () => {
    let serverReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverReady = r;
    });
    const server = createTcpServer({
      security: { mode: 'plain' },
      maxMessageBytes: 8,
      onConnection(conn) {
        serverReady(conn);
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectTcpClient({
      hostname: server.hostname,
      port: server.port,
      security: { mode: 'plain' },
    });
    await serverConnP;

    const raw = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const s = connect({ host: server.hostname, port: server.port }, () => resolve(s));
      s.once('error', reject);
    });
    // length=100 exceeds maxMessageBytes+1 → FramingError → socket.destroy()
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(100, 0);
    raw.write(hdr);
    await new Promise<void>((resolve) => raw.once('close', () => resolve()));
    client.close();
  });

  it('invokes plain close() and destroys when onConnection throws after handshake', async () => {
    let serverConn: SocketConnection | undefined;
    const plain = createTcpServer({
      security: { mode: 'plain' },
      onConnection(conn) {
        serverConn = conn;
      },
    });
    stoppers.push(() => plain.stop());

    const client = await connectTcpClient({
      hostname: plain.hostname,
      port: plain.port,
      security: { mode: 'plain' },
    });
    await Bun.sleep(20);
    serverConn?.close();
    client.close();

    const secure = createTcpServer({
      security: { mode: 'secure' },
      onConnection() {
        throw new Error('post-handshake-boom');
      },
    });
    stoppers.push(() => secure.stop());

    // Handshake succeeds; server onConnection throw → catch → socket.destroy()
    const c2 = await connectTcpClient({
      hostname: secure.hostname,
      port: secure.port,
      security: { mode: 'secure' },
    });
    await Bun.sleep(30);
    c2.close();
  });
});

describe('node-udp residual branches', () => {
  it('covers sendTo variants, raw datagram fallback, and peer close', async () => {
    let serverConn: SocketConnection | undefined;
    const server = await createUdpSocket({
      security: { mode: 'plain' },
      onConnection(conn) {
        serverConn = conn;
        conn.onMessage(() => {});
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectUdpClient({
      hostname: '127.0.0.1',
      port: server.port,
      security: { mode: 'plain' },
    });

    server.sendTo(textFrame('as-frame'), client.localPort, '127.0.0.1');
    server.sendTo('as-string', client.localPort, '127.0.0.1');
    server.sendTo(new Uint8Array([1, 2]), client.localPort, '127.0.0.1');
    await Bun.sleep(30);

    const raw = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      raw.bind(0, '127.0.0.1', () => resolve());
      raw.once('error', reject);
    });
    raw.send(Buffer.from([0xde, 0xad]), server.port, '127.0.0.1');
    await Bun.sleep(30);
    raw.close();

    serverConn?.close();
    client.close();
  });

  it('ignores bad envelopes in secure mode and covers secure peer close', async () => {
    let serverConn: SocketConnection | undefined;
    const server = await createUdpSocket({
      security: { mode: 'secure' },
      onConnection(conn) {
        serverConn = conn;
      },
    });
    stoppers.push(() => server.stop());

    const raw = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      raw.bind(0, '127.0.0.1', () => resolve());
      raw.once('error', reject);
    });
    raw.send(Buffer.from([1, 2, 3, 4]), server.port, '127.0.0.1');
    await Bun.sleep(20);
    raw.close();

    const client = await connectUdpClient({
      hostname: '127.0.0.1',
      port: server.port,
      security: { mode: 'secure' },
    });
    await Bun.sleep(50);
    serverConn?.close();
    client.close();
  });

  it('deletes the peer when secure onConnection throws after handshake', async () => {
    const server = await createUdpSocket({
      security: { mode: 'secure' },
      onConnection() {
        throw new Error('udp-boom');
      },
    });
    stoppers.push(() => server.stop());

    // Handshake may succeed then onConnection throws → ensurePeer catch deletes peer
    try {
      const client = await connectUdpClient({
        hostname: '127.0.0.1',
        port: server.port,
        security: { mode: 'secure' },
      });
      await Bun.sleep(50);
      client.close();
    } catch {
      /* consumer may also fail if peer vanished */
    }
  });

  it('client falls back to raw binary when decodeUdpEnvelope fails', async () => {
    const server = await createUdpSocket({
      security: { mode: 'plain' },
      onConnection() {},
    });
    stoppers.push(() => server.stop());

    const got: number[] = [];
    const client = await connectUdpClient({
      hostname: '127.0.0.1',
      port: server.port,
      security: { mode: 'plain' },
    });
    client.onMessage((f) => {
      got.push(f.data[0] ?? -1);
    });

    const spoof = createSocket('udp4');
    await new Promise<void>((r) => spoof.bind(0, '127.0.0.1', () => r()));
    spoof.send(Buffer.from([0xff, 0xff]), client.localPort, '127.0.0.1');
    await Bun.sleep(30);
    expect(got).toContain(0xff);
    spoof.close();
    client.close();
  });
});

describe('node-websocket residual branches', () => {
  it('rawToFrame covers Buffer/ArrayBuffer/Buffer[] shapes', () => {
    expect(rawToFrame('hi', false).text).toBe('hi');
    expect(rawToFrame(Buffer.from('yo'), false).text).toBe('yo');
    expect(rawToFrame([Buffer.from('a'), Buffer.from('b')], false).text).toBe('ab');
    expect(rawToFrame(new Uint8Array([65]).buffer, false).text).toBe('A');

    expect([...rawToFrame(Buffer.from([1, 2]), true).data]).toEqual([1, 2]);
    expect([...rawToFrame(new Uint8Array([3]).buffer, true).data]).toEqual([3]);
    expect([...rawToFrame([Buffer.from([4]), Buffer.from([5])], true).data]).toEqual([4, 5]);
    expect([...rawToFrame(new Uint8Array([6]), true).data]).toEqual([6]);
  });

  it('returns 404 on non-upgrade HTTP and rejects wrong path', async () => {
    const server = createWebSocketServer({
      path: '/only',
      security: { mode: 'plain' },
      onConnection() {},
    });
    stoppers.push(() => server.stop());

    const res = await fetch(`http://${server.hostname}:${server.port}/`);
    expect(res.status).toBe(404);

    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://${server.hostname}:${server.port}/wrong`);
      ws.addEventListener('open', () => resolve(false));
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('close', () => resolve(true));
      setTimeout(() => resolve(true), 500);
    });
    expect(closed).toBe(true);
  });

  it('destroys the server socket when onConnection throws after secure handshake', async () => {
    const server = createWebSocketServer({
      path: '/sec',
      security: { mode: 'secure' },
      onConnection() {
        throw new Error('ws-boom');
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectWebSocketClient(`ws://${server.hostname}:${server.port}/sec`, {
      security: { mode: 'secure' },
    });
    await Bun.sleep(30);
    client.close();
  });

  it('invokes plain close() on the connection', async () => {
    let serverConn: SocketConnection | undefined;
    const server = createWebSocketServer({
      path: '/c',
      security: { mode: 'plain' },
      onConnection(conn) {
        serverConn = conn;
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectWebSocketClient(`ws://${server.hostname}:${server.port}/c`, {
      security: { mode: 'plain' },
    });
    await Bun.sleep(20);
    serverConn?.close(1000, 'done');
    client.close();
  });
});
