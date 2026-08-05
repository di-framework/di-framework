import { afterEach, describe, expect, it } from 'bun:test';
import { connectBunWebSocketClient, createBunWebSocketServer } from '../bun.ts';
import { binaryFrame, textFrame, toFrame } from '../index.ts';

const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const s of stoppers.splice(0)) s();
});

describe('toFrame defaults', () => {
  it('maps string → text and Uint8Array → binary', () => {
    expect(toFrame('hi').kind).toBe('text');
    expect(toFrame('hi').text).toBe('hi');
    expect(toFrame(new Uint8Array([1])).kind).toBe('binary');
  });
});

describe('WebSocket text vs binary opcodes', () => {
  it('preserves text and binary frames in plain mode', async () => {
    const received: Array<{ kind: string; text?: string; bytes?: number[] }> = [];

    let ready!: () => void;
    const readyP = new Promise<void>((r) => {
      ready = r;
    });

    const server = createBunWebSocketServer({
      path: '/f',
      security: { mode: 'plain' },
      onConnection(conn) {
        ready();
        conn.onMessage(async (frame) => {
          received.push({
            kind: frame.kind,
            text: frame.text,
            bytes: frame.kind === 'binary' ? [...frame.data] : undefined,
          });
          // echo same kind
          await conn.send(frame);
        });
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectBunWebSocketClient(`ws://${server.hostname}:${server.port}/f`, {
      security: { mode: 'plain' },
    });
    await readyP;

    const textReply = new Promise<string>((resolve) => {
      const off = client.onMessage((frame) => {
        if (frame.kind === 'text' && frame.text === 'hello') {
          off();
          resolve(frame.kind);
        }
      });
    });
    await client.send(textFrame('hello'));
    expect(await textReply).toBe('text');

    const binReply = new Promise<number[]>((resolve) => {
      const off = client.onMessage((frame) => {
        if (frame.kind === 'binary') {
          off();
          resolve([...frame.data]);
        }
      });
    });
    await client.send(binaryFrame(new Uint8Array([10, 20, 30])));
    expect(await binReply).toEqual([10, 20, 30]);

    expect(received.some((r) => r.kind === 'text' && r.text === 'hello')).toBe(true);
    expect(received.some((r) => r.kind === 'binary' && r.bytes?.join() === '10,20,30')).toBe(true);

    client.close();
  });

  it('preserves kinds through the secure channel', async () => {
    let ready!: () => void;
    const readyP = new Promise<void>((r) => {
      ready = r;
    });

    const server = createBunWebSocketServer({
      path: '/s',
      security: { mode: 'secure' },
      onConnection(conn) {
        ready();
        conn.onMessage(async (frame) => {
          await conn.send(frame);
        });
      },
    });
    stoppers.push(() => server.stop());

    const client = await connectBunWebSocketClient(`ws://${server.hostname}:${server.port}/s`, {
      security: { mode: 'secure' },
    });
    await readyP;

    const textReply = new Promise<string>((resolve) => {
      client.onMessage((frame) => {
        if (frame.kind === 'text') resolve(frame.text ?? '');
      });
    });
    await client.send('secure-text');
    expect(await textReply).toBe('secure-text');

    const binReply = new Promise<number[]>((resolve) => {
      client.onMessage((frame) => {
        if (frame.kind === 'binary') resolve([...frame.data]);
      });
    });
    await client.send(new Uint8Array([0xde, 0xad]));
    expect(await binReply).toEqual([0xde, 0xad]);

    client.close();
  });
});
