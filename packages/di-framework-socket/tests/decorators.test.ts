import { afterEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';
import { connectWebSocketClient } from '../node.ts';
import type { SocketConnection } from '../src/core/types.ts';
import {
  OnClose,
  OnConnect,
  OnError,
  OnMessage,
  SocketGateway,
  startSocketGateways,
  stopSocketGateways,
} from '../src/decorators.ts';
import registry, { SocketGatewayRegistry } from '../src/registry.ts';
import type { SocketListenFactory } from '../src/types.ts';

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
      server: { protocol: 'websocket', path: '/chat', port: 0 },
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

    const client = await connectWebSocketClient(`ws://${hostname}:${port}/chat`, {
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
      server: { protocol: 'websocket', path: '/p', port: 0 },
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
    const client = await connectWebSocketClient(
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

  it('routes handler errors to @OnError, ignores malformed/mismatched typed JSON, and dispatches @OnClose', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];

    // A hand-rolled connection + custom `listen` factory gives full control over
    // firing onMessage/onClose so we can cover every wireConnection() branch
    // (malformed JSON, type mismatch, handler throw -> @OnError, @OnClose dispatch)
    // without depending on whether a real transport ever calls dispatchClose.
    let messageHandler:
      | ((frame: { kind: string; text?: string; data: Uint8Array }) => void)
      | undefined;
    let closeHandler: ((info: { code?: number; reason?: string }) => void) | undefined;
    const customListen: SocketListenFactory = ({ onConnection }) => {
      const conn: SocketConnection = {
        id: 'fake',
        protocol: 'websocket',
        securityMode: 'plain',
        send: () => {},
        close: () => {},
        onMessage(handler) {
          messageHandler = handler as typeof messageHandler;
          return () => {
            messageHandler = undefined;
          };
        },
        onClose(handler) {
          closeHandler = handler;
          return () => {
            closeHandler = undefined;
          };
        },
      };
      void onConnection(conn);
      return { protocol: 'websocket', securityMode: 'plain', stop: () => {} };
    };

    @SocketGateway({ listen: customListen, autoStart: false })
    class ErrorGateway {
      @OnMessage({ type: 'boom' })
      onBoom() {
        throw new Error('kaboom');
      }

      @OnMessage({ type: 'boom' })
      onBoomTwo(_conn: SocketConnection, _frame: unknown, _msg: unknown) {
        seen.push('second-handler-still-ran');
      }

      @OnMessage({ frame: 'text', type: 'ignored-type' })
      onTypedIgnored() {
        seen.push('should-not-run');
      }

      @OnError()
      onError(_conn: SocketConnection, error: unknown) {
        errors.push(error);
      }

      @OnClose()
      onClose() {
        seen.push('closed');
      }
    }

    const gateway = useContainer().resolve(ErrorGateway) as ErrorGateway & {
      $startGateway: () => Promise<unknown>;
    };
    await gateway.$startGateway();
    await Bun.sleep(0);

    // Malformed JSON for a typed handler: JSON.parse throws -> `continue`.
    messageHandler?.({ kind: 'text', text: '{not json', data: new Uint8Array() });
    // Well-formed JSON but mismatched `type` -> `continue`.
    messageHandler?.({
      kind: 'text',
      text: JSON.stringify({ type: 'not-boom' }),
      data: new Uint8Array(),
    });
    // Matches `boom`: first handler throws, routed to @OnError; second handler still runs.
    messageHandler?.({
      kind: 'text',
      text: JSON.stringify({ type: 'boom' }),
      data: new Uint8Array(),
    });
    await Bun.sleep(20);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('kaboom');
    expect(seen).toContain('second-handler-still-ran');
    expect(seen).not.toContain('should-not-run');

    closeHandler?.({ code: 1000, reason: 'bye' });
    await Bun.sleep(0);
    expect(seen).toContain('closed');
  });

  it('supports a custom `listen` factory, idempotent start, and manual start/stop', async () => {
    let listenCalls = 0;
    let stopCalls = 0;
    const fakeConnections: Array<(c: SocketConnection) => void> = [];

    const customListen: SocketListenFactory = ({ onConnection }) => {
      listenCalls++;
      fakeConnections.push(onConnection);
      return {
        protocol: 'websocket',
        securityMode: 'plain',
        stop() {
          stopCalls++;
        },
      };
    };

    @SocketGateway({ listen: customListen, autoStart: false })
    class CustomGateway {}

    const gateway = useContainer().resolve(CustomGateway) as CustomGateway & {
      $startGateway: () => Promise<unknown>;
      $stopGateway: () => Promise<void>;
    };

    const server1 = await gateway.$startGateway();
    // Second call while already started returns the cached server (line 178/209-210 branch).
    const server2 = await gateway.$startGateway();
    expect(server1).toBe(server2);
    expect(listenCalls).toBe(1);

    // Exercise the handle's `started` / `server` getters directly.
    const handle = (gateway as unknown as Record<symbol, { started: boolean; server: unknown }>)[
      Symbol.for('di-framework.socket.gateway-handle')
    ];
    expect(handle).toBeDefined();
    expect(handle!.started).toBe(true);
    expect(handle!.server).toBe(server1);

    await gateway.$stopGateway();
    expect(stopCalls).toBe(1);
  });

  it('startSocketGateways()/stopSocketGateways() start and stop every registered gateway', async () => {
    let started = 0;
    let stopped = 0;
    const customListen: SocketListenFactory = () => {
      started++;
      return {
        protocol: 'websocket',
        securityMode: 'plain',
        stop() {
          stopped++;
        },
      };
    };

    @SocketGateway({ listen: customListen, autoStart: false })
    class ManualGateway {}

    useContainer().resolve(ManualGateway);
    const servers = await startSocketGateways([ManualGateway]);
    expect(servers).toHaveLength(1);
    expect(started).toBe(1);

    await stopSocketGateways([ManualGateway]);
    expect(stopped).toBe(1);
  });

  it('throws when a gateway has neither `server` nor `listen`', async () => {
    @SocketGateway({ autoStart: false })
    class NoListenGateway {}

    const gateway = useContainer().resolve(NoListenGateway) as NoListenGateway & {
      $startGateway: () => Promise<unknown>;
    };
    await expect(gateway.$startGateway()).rejects.toThrow(/requires either/);
  });

  it('logs via console.error when autoStart $startGateway rejects', async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      @SocketGateway({
        autoStart: true,
        listen: async () => {
          throw new Error('listen-fail');
        },
      })
      class FailGateway {}

      useContainer().resolve(FailGateway);
      await Bun.sleep(30);
      expect(
        errors.some(
          (a) =>
            String(a).includes('listen-fail') ||
            String((a as unknown[])[0]).includes('SocketGateway'),
        ),
      ).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});
