import { afterEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';
import { connectBunWebSocketClient } from '../bun.ts';
import type { SocketConnection } from '../src/core/types.ts';
import {
  OnClose,
  OnConnect,
  OnMessage,
  SocketGateway,
  stopSocketGateways,
} from '../src/decorators.ts';
import registry from '../src/registry.ts';

afterEach(async () => {
  await stopSocketGateways();
  useContainer().clear();
  registry.clear();
});

describe('@SocketGateway decorators', () => {
  it('registers with DI, injects components, and dispatches lifecycle handlers', async () => {
    @Container()
    class LoggerService {
      lines: string[] = [];
      log(msg: string) {
        this.lines.push(msg);
      }
    }

    const seen: string[] = [];

    @SocketGateway({
      bun: { protocol: 'websocket', path: '/chat', port: 0 },
      security: { mode: 'secure' },
      autoStart: true,
    })
    class ChatGateway {
      @Component(LoggerService)
      logger!: LoggerService;

      @OnConnect()
      open(conn: SocketConnection) {
        this.logger.log(`open:${conn.id}`);
        seen.push('open');
      }

      @OnMessage({ frame: 'text', type: 'chat' })
      async onChat(
        conn: SocketConnection,
        _frame: import('../index.ts').SocketFrame,
        msg: { text: string },
      ) {
        seen.push(`chat:${msg.text}`);
        await conn.send(JSON.stringify({ type: 'chat', text: `echo:${msg.text}` }));
      }

      @OnMessage()
      onAny(_conn: SocketConnection, frame: import('../index.ts').SocketFrame) {
        if (frame.kind === 'text' && frame.text && !frame.text.includes('"type"')) {
          seen.push(`raw:${frame.text}`);
        }
      }

      @OnClose()
      close() {
        seen.push('close');
      }
    }

    // Resolve gateway (autoStart listens) and logger
    const gateway = useContainer().resolve(ChatGateway) as ChatGateway & {
      $startGateway: () => Promise<{ port: number; hostname: string }>;
    };
    // Wait for microtask autoStart
    await Bun.sleep(20);
    const server = await gateway.$startGateway();
    const port = (server as { port: number }).port;
    const hostname = (server as { hostname: string }).hostname;

    const client = await connectBunWebSocketClient(`ws://${hostname}:${port}/chat`, {
      security: { mode: 'secure' },
    });

    await Bun.sleep(20);
    expect(seen).toContain('open');

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? ''));
    });
    await client.send(JSON.stringify({ type: 'chat', text: 'hi' }));
    expect(await reply).toBe(JSON.stringify({ type: 'chat', text: 'echo:hi' }));
    expect(seen.some((s) => s === 'chat:hi')).toBe(true);

    const logger = useContainer().resolve(LoggerService);
    expect(logger.lines.some((l) => l.startsWith('open:'))).toBe(true);

    client.close();
    await Bun.sleep(20);
  });

  it('supports plain mode and untyped @OnMessage', async () => {
    const messages: string[] = [];

    @SocketGateway({
      bun: { protocol: 'websocket', path: '/p', port: 0 },
      security: { mode: 'plain' },
    })
    class EchoGateway {
      @OnMessage({ frame: 'text' })
      async onMessage(conn: SocketConnection, frame: import('../index.ts').SocketFrame) {
        const text = frame.text ?? '';
        messages.push(text);
        await conn.send(text.toUpperCase());
      }
    }

    const gateway = useContainer().resolve(EchoGateway) as EchoGateway & {
      $startGateway: () => Promise<{ port: number; hostname: string }>;
    };
    await Bun.sleep(20);
    const server = await gateway.$startGateway();
    const client = await connectBunWebSocketClient(
      `ws://${(server as { hostname: string }).hostname}:${(server as { port: number }).port}/p`,
      { security: { mode: 'plain' } },
    );

    const reply = new Promise<string>((resolve) => {
      client.onMessage((frame) => resolve(frame.text ?? ''));
    });
    await client.send('hey');
    expect(await reply).toBe('HEY');
    expect(messages).toEqual(['hey']);
    client.close();
  });
});
