import { afterEach, describe, expect, it } from 'bun:test';
import type { SocketConnection } from '../index.ts';
import { connectWebSocketClient, createWebSocketServer } from '../node.ts';

const servers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

describe('Node WebSocket adapter (node:http + ws)', () => {
  it('completes secure handshake and exchanges messages', async () => {
    let serverConnReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverConnReady = r;
    });

    const server = createWebSocketServer({
      path: '/ws',
      security: { mode: 'secure' },
      onConnection(conn) {
        serverConnReady(conn);
        conn.onMessage(async (frame) => {
          const text = frame.text ?? new TextDecoder().decode(frame.data);
          await conn.send(`echo:${text}`);
        });
      },
    });
    servers.push(server);

    const client = await connectWebSocketClient(`ws://${server.hostname}:${server.port}/ws`, {
      security: { mode: 'secure' },
    });
    await serverConnP;

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? new TextDecoder().decode(frame.data)));
    });

    await client.send('hi');
    expect(await reply).toBe('echo:hi');

    client.close();
  });

  it('supports explicit plain mode', async () => {
    let serverConnReady!: (c: SocketConnection) => void;
    const serverConnP = new Promise<SocketConnection>((r) => {
      serverConnReady = r;
    });

    const server = createWebSocketServer({
      path: '/plain',
      security: { mode: 'plain' },
      onConnection(conn) {
        serverConnReady(conn);
        conn.onMessage((frame) => {
          void conn.send((frame.text ?? '').toUpperCase());
        });
      },
    });
    servers.push(server);

    const client = await connectWebSocketClient(`ws://${server.hostname}:${server.port}/plain`, {
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
