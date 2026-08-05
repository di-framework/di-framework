import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { memoryPair } from '../src/adapters/memory.ts';
import { createRpcClient } from '../src/client.ts';
import { RpcField, RpcMessage, RpcMethod, RpcService } from '../src/decorators.ts';
import registry from '../src/registry.ts';
import { createRpcServer } from '../src/server.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

function defineEcho() {
  @RpcMessage()
  class EchoRequest {
    @RpcField(1)
    value!: string;
  }
  @RpcMessage()
  class EchoResponse {
    @RpcField(1)
    value!: string;
  }
  @RpcService({ package: 'client-gaps.v1' })
  class EchoService {
    @RpcMethod({ input: () => EchoRequest, output: () => EchoResponse })
    echo(request: EchoRequest): EchoResponse {
      return { value: request.value };
    }
  }
  return { EchoService };
}

describe('createRpcClient - service/path resolution', () => {
  it('throws when a non-decorated class is passed as the service', () => {
    class NotAService {}
    const pair = memoryPair();
    expect(() => createRpcClient(NotAService, pair.clientTransport)).toThrow(
      /is not decorated with @RpcService/,
    );
  });

  it('supports the string-service overload (transport, { service })', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();

    const client = createRpcClient<{ echo(input: { value: string }): Promise<{ value: string }> }>(
      pair.clientTransport,
      { service: 'client-gaps.v1.EchoService' },
    );
    await expect(client.echo({ value: 'hi' })).resolves.toEqual({ value: 'hi' });
    await server.stop();
  });
});

describe('createRpcClient - abort signal merging', () => {
  it('rejects immediately when the provided signal is already aborted', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    const client = createRpcClient(EchoService, pair.clientTransport, {
      signal: controller.signal,
    });
    await expect(client.echo({ value: 'x' })).rejects.toThrow('pre-aborted');
  });

  it('merges a per-call signal with the client-level signal (AbortSignal.any path)', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();

    const clientController = new AbortController();
    const callController = new AbortController();
    const client = createRpcClient(EchoService, pair.clientTransport, {
      signal: clientController.signal,
    });

    await expect(
      client.echo({ value: 'ok' }, { signal: callController.signal }),
    ).resolves.toEqual({ value: 'ok' });
    await server.stop();
  });

  it('falls back to manual signal merging when AbortSignal.any is unavailable', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error - intentionally removing to exercise the fallback branch.
    AbortSignal.any = undefined;
    try {
      const { EchoService } = defineEcho();
      const pair = memoryPair();
      const clientController = new AbortController();
      const callController = new AbortController();
      const client = createRpcClient(EchoService, pair.clientTransport, {
        signal: clientController.signal,
      });
      const pending = client.echo({ value: 'x' }, { signal: callController.signal });
      // Let the pre-send microtasks (ensureStarted + registerPending) run so the
      // manual-merge abort listener is attached *before* we abort, exercising
      // the "abort fires after registration" branch (and its cleanup) rather
      // than the "already aborted at merge time" early-return branch.
      await Bun.sleep(0);
      callController.abort(new Error('call aborted'));
      await expect(pending).rejects.toThrow('call aborted');
    } finally {
      AbortSignal.any = original;
    }
  });

  it('cleans up manually-merged abort listeners when the call settles normally', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error - intentionally removing to exercise the fallback branch.
    AbortSignal.any = undefined;
    try {
      const { EchoService } = defineEcho();
      const pair = memoryPair();
      const server = createRpcServer({ transport: pair.serverTransport });
      await server.start();
      const clientController = new AbortController();
      const callController = new AbortController();
      const client = createRpcClient(EchoService, pair.clientTransport, {
        signal: clientController.signal,
      });
      await expect(
        client.echo({ value: 'ok' }, { signal: callController.signal }),
      ).resolves.toEqual({ value: 'ok' });
      await server.stop();
    } finally {
      AbortSignal.any = original;
    }
  });

  it('aborts with a synthesized error when the abort reason is not an Error instance', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const controller = new AbortController();
    const client = createRpcClient(EchoService, pair.clientTransport, {
      signal: controller.signal,
    });
    const pending = client.echo({ value: 'x' });
    controller.abort('plain-string-reason');
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe('createRpcClient - $batch edge cases', () => {
  it('returns an empty result immediately when the batch builder queues no calls', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const client = createRpcClient(EchoService, pair.clientTransport);
    const result = await client.$batch(() => []);
    expect(result).toEqual([]);
  });

  it('rejects pending calls via rejectPayload when transport.send fails (single call)', async () => {
    const { EchoService } = defineEcho();
    const failing = {
      async send() {
        throw new Error('send-boom');
      },
      subscribe() {
        return () => {};
      },
    };
    const client = createRpcClient(EchoService, failing);
    await expect(client.echo({ value: 'x' })).rejects.toThrow('send-boom');
  });

  it('rejects pending batch calls when transport.send fails (non-Error reason)', async () => {
    @RpcMessage()
    class PingRequest {
      @RpcField(1)
      value!: string;
    }
    @RpcService({ package: 'client-gaps.batch.v1' })
    class MixedService {
      @RpcMethod({ input: () => PingRequest, output: () => PingRequest })
      echo(request: PingRequest): PingRequest {
        return request;
      }
      @RpcMethod({ input: () => PingRequest, notification: true })
      ping(_request: PingRequest): void {}
    }

    let sendCount = 0;
    const failing = {
      async send() {
        sendCount++;
        throw 'batch-send-failed';
      },
      subscribe() {
        return () => {};
      },
    };
    const client = createRpcClient(MixedService, failing, { timeoutMs: 5_000 });
    await expect(
      client.$batch((rpc) => [rpc.ping({ value: 'n' }), rpc.echo({ value: 'a' })] as const),
    ).rejects.toThrow('batch-send-failed');
    expect(sendCount).toBe(1);
  });

  it('covers notification send failures (no pending id)', async () => {
    @RpcMessage()
    class PingRequest {
      @RpcField(1)
      value!: string;
    }
    @RpcService({ package: 'client-gaps.notify.v1' })
    class NotifyService {
      @RpcMethod({ input: () => PingRequest, notification: true })
      ping(_request: PingRequest): void {}
    }

    const transport = {
      async send() {
        throw new Error('after-register');
      },
      subscribe() {
        return () => {};
      },
    };

    const client = createRpcClient(NotifyService, transport);
    await expect(client.ping({ value: 'x' })).rejects.toThrow('after-register');
  });
});

describe('createRpcClient - call-options-only args', () => {
  it('treats a single call-options-only argument as {} params (onlyCallOptionKeys)', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(EchoService, pair.clientTransport);

    const result = await client.echo({ timeoutMs: 1000 } as unknown as { value: string });
    expect(result).toEqual({ value: undefined });
    await server.stop();
  });
});

describe('createRpcClient - interceptor guard', () => {
  it('throws when an interceptor calls next() more than once', async () => {
    const { EchoService } = defineEcho();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(EchoService, pair.clientTransport, {
      interceptors: [
        async (_ctx, next) => {
          await next();
          return next();
        },
      ],
    });
    await expect(client.echo({ value: 'x' })).rejects.toThrow(/next\(\) multiple times/);
    await server.stop();
  });
});
