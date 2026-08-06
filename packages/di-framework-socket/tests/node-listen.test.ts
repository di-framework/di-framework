import { describe, expect, it } from 'bun:test';
import { createNodeListen, type NodeServerOptions } from '../src/adapters/node-listen.ts';

describe('createNodeListen', () => {
  it('dispatches to createWebSocketServer for protocol "websocket"', async () => {
    const listen = createNodeListen({ protocol: 'websocket', port: 0 }, 'plain', undefined);
    const server = await listen({ securityMode: 'plain', onConnection: () => {} });
    expect(server.protocol).toBe('websocket');
    await server.stop();
  });

  it('dispatches to createTcpServer for protocol "tcp"', async () => {
    const listen = createNodeListen({ protocol: 'tcp', port: 0 }, 'plain', undefined);
    const server = await listen({ securityMode: 'plain', onConnection: () => {} });
    expect(server.protocol).toBe('tcp');
    await server.stop();
  });

  it('dispatches to createUdpSocket for protocol "udp"', async () => {
    const listen = createNodeListen({ protocol: 'udp', port: 0 }, 'plain', undefined);
    const server = await listen({ securityMode: 'plain', onConnection: () => {} });
    expect(server.protocol).toBe('udp');
    await server.stop();
  });

  it('throws for an unsupported protocol', () => {
    const listen = createNodeListen(
      { protocol: 'sctp' } as unknown as NodeServerOptions,
      'plain',
      undefined,
    );
    expect(() => listen({ securityMode: 'plain', onConnection: () => {} })).toThrow(
      /Unsupported protocol/,
    );
  });
});
