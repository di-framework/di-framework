import { describe, expect, it } from 'bun:test';
import {
  createRpcClient,
  createRpcServer,
  memoryPair,
  RPC_CONNECT_CODES,
  RpcAppError,
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcRemoteError,
  RpcService,
  RpcStream,
  Stream,
} from '../index.ts';
import type { RpcInterceptor, RpcServerInterceptor } from '../src/types.ts';

@RpcMessage()
class NumberReq {
  @RpcField(1)
  count!: number;
}

@RpcMessage()
class NumberItem {
  @RpcField(1)
  value!: number;
}

@RpcService({ package: 'lifecycle.v1' })
class LifecycleService {
  static generatorCleanedUp = false;

  @RpcMethod({ input: () => NumberReq, output: () => NumberItem })
  async *slowStream(req: NumberReq): AsyncIterable<NumberItem> {
    LifecycleService.generatorCleanedUp = false;
    try {
      for (let i = 1; i <= req.count; i++) {
        await new Promise((r) => setTimeout(r, 20));
        yield { value: i };
      }
    } finally {
      LifecycleService.generatorCleanedUp = true;
    }
  }

  @RpcMethod({ input: () => NumberReq, output: () => NumberItem })
  async *failingStream(_req: NumberReq): AsyncIterable<NumberItem> {
    yield { value: 1 };
    throw new RpcAppError('Stream error occurred', {
      code: -32001,
      connectCode: RPC_CONNECT_CODES.INVALID_ARGUMENT,
      data: { details: 'bad state' },
    });
  }

  @RpcStream({ input: () => Stream(NumberItem), output: () => Stream(NumberItem) })
  async *echoStream(items: AsyncIterable<NumberItem>): AsyncIterable<NumberItem> {
    for await (const item of items) {
      yield { value: item.value * 10 };
    }
  }
}

describe('streaming lifecycle, cancellation, interceptors, and error boundaries', () => {
  it('cancellation via AbortSignal mid-stream', async () => {
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(LifecycleService, pair.clientTransport);

    const controller = new AbortController();
    const items: number[] = [];

    let caughtError: unknown;
    try {
      const stream = client.slowStream({ count: 10 }, { signal: controller.signal });
      for await (const item of stream) {
        items.push(item.value);
        if (items.length === 2) {
          controller.abort(new Error('User canceled stream'));
        }
      }
    } catch (err) {
      caughtError = err;
    }

    expect(items.length).toBe(2);
    expect(caughtError).toBeDefined();

    // Verify server generator cleanup
    await new Promise((r) => setTimeout(r, 50));
    expect(LifecycleService.generatorCleanedUp).toBe(true);

    await server.stop();
  });

  it('exception propagation: RpcAppError -> stream: "error" -> RpcRemoteError', async () => {
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(LifecycleService, pair.clientTransport);

    const items: number[] = [];
    let remoteErr: RpcRemoteError | undefined;

    try {
      for await (const item of client.failingStream({ count: 5 })) {
        items.push(item.value);
      }
    } catch (err) {
      if (err instanceof RpcRemoteError) {
        remoteErr = err;
      }
    }

    expect(items).toEqual([1]);
    expect(remoteErr).toBeDefined();
    expect(remoteErr?.code).toBe(-32001);
    expect(remoteErr?.message).toBe('Stream error occurred');
    expect(remoteErr?.data).toEqual({ details: 'bad state' });

    await server.stop();
  });

  it('client and server interceptors wrap stream initiation and item iterations', async () => {
    const pair = memoryPair();

    const clientLog: string[] = [];
    const serverLog: string[] = [];

    const clientInterceptor: RpcInterceptor = async (ctx, next) => {
      clientLog.push(`client:${ctx.method}:${JSON.stringify(ctx.params)}`);
      return next();
    };

    const serverInterceptor: RpcServerInterceptor = async (ctx, next) => {
      serverLog.push(`server:${ctx.method}:${JSON.stringify(ctx.params)}`);
      return next();
    };

    const server = createRpcServer({
      transport: pair.serverTransport,
      interceptors: [serverInterceptor],
    });
    await server.start();

    const client = createRpcClient(LifecycleService, pair.clientTransport, {
      interceptors: [clientInterceptor],
    });

    const items: number[] = [];
    for await (const item of client.echoStream(
      (async function* () {
        yield { value: 1 };
        yield { value: 2 };
      })(),
    )) {
      items.push(item.value);
    }

    expect(items).toEqual([10, 20]);

    expect(clientLog.some((l) => l.includes('EchoStream'))).toBe(true);
    expect(serverLog.some((l) => l.includes('EchoStream'))).toBe(true);

    await server.stop();
  });

  it('50+ concurrent streaming calls on a single transport without message interleaving', async () => {
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(LifecycleService, pair.clientTransport);

    const CONCURRENCY = 50;
    const tasks = Array.from({ length: CONCURRENCY }, async (_, _idx) => {
      const items: number[] = [];
      for await (const item of client.slowStream({ count: 3 })) {
        items.push(item.value);
      }
      return items;
    });

    const results = await Promise.all(tasks);
    expect(results.length).toBe(50);
    for (const res of results) {
      expect(res).toEqual([1, 2, 3]);
    }

    await server.stop();
  });
});
