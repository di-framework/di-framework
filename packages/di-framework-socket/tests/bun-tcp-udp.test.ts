import { afterEach, describe, expect, it } from 'bun:test';
import type { SocketConnection } from '../index.ts';
import {
  connectTcpClient,
  connectUdpClient,
  createTcpServer,
  createUdpSocket,
} from '../node.ts';

const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

describe('Node TCP adapter (node:net)', () => {
  it('exchanges sealed messages over secure TCP', async () => {
    let serverReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverReady = r;
    });

    const server = createTcpServer({
      security: { mode: 'secure' },
      onConnection(conn) {
        serverReady(conn);
        conn.onMessage(async (frame) => {
          const text = frame.text ?? new TextDecoder().decode(frame.data);
          await conn.send(`tcp:${text}`);
        });
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectTcpClient({
      hostname: server.hostname,
      port: server.port,
      security: { mode: 'secure' },
    });
    await serverConnP;

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? new TextDecoder().decode(frame.data)));
    });
    await client.send('hello');
    expect(await reply).toBe('tcp:hello');
    client.close();
  });

  it('supports plain TCP with length-prefix framing', async () => {
    let serverReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverReady = r;
    });

    const server = createTcpServer({
      security: { mode: 'plain' },
      onConnection(conn) {
        serverReady(conn);
        conn.onMessage((frame) => {
          void conn.send((frame.text ?? '').toUpperCase());
        });
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectTcpClient({
      hostname: server.hostname,
      port: server.port,
      security: { mode: 'plain' },
    });
    await serverConnP;

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? ''));
    });
    await client.send('hey');
    expect(await reply).toBe('HEY');
    client.close();
  });
});

describe('Node UDP adapter (node:dgram)', () => {
  it('exchanges sealed messages over secure UDP', async () => {
    let serverReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverReady = r;
    });

    const server = await createUdpSocket({
      security: { mode: 'secure' },
      onConnection(conn) {
        serverReady(conn);
        conn.onMessage(async (frame) => {
          const text = frame.text ?? new TextDecoder().decode(frame.data);
          await conn.send(`udp:${text}`);
        });
      },
    });
    stoppers.push(() => server.stop());

    const clientP = connectUdpClient({
      hostname: '127.0.0.1',
      port: server.port,
      security: { mode: 'secure' },
    });
    const [client] = await Promise.all([clientP, serverConnP]);

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? new TextDecoder().decode(frame.data)));
    });
    await client.send('hi');
    expect(await reply).toBe('udp:hi');
    client.close();
  });

  it('supports plain UDP envelopes', async () => {
    let serverReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverReady = r;
    });

    const server = await createUdpSocket({
      security: { mode: 'plain' },
      onConnection(conn) {
        serverReady(conn);
        conn.onMessage((frame) => {
          void conn.send(`got:${frame.text ?? ''}`);
        });
      },
    });
    stoppers.push(() => server.stop());

    const clientP = connectUdpClient({
      hostname: '127.0.0.1',
      port: server.port,
      security: { mode: 'plain' },
    });
    const [client] = await Promise.all([clientP, serverConnP]);

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? ''));
    });
    await client.send('ping');
    expect(await reply).toBe('got:ping');
    client.close();
  });
});
