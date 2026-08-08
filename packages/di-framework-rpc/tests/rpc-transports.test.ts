import { beforeEach, describe, expect, it } from 'bun:test';
import { Code, createRouterTransport } from '@connectrpc/connect';
import { useContainer } from '@di-framework/core/container';
import { createGrpcRoutes, grpcTransport } from '../src/adapters/grpc.ts';
import { createHttpRpcHandler, httpTransport } from '../src/adapters/http.ts';
import { memoryPair } from '../src/adapters/memory.ts';
import { createRpcClient } from '../src/client.ts';
import { RpcField, RpcMessage, RpcMethod, RpcService } from '../src/decorators.ts';
import { createRpcDispatcher } from '../src/dispatcher.ts';
import registry from '../src/registry.ts';
import { createRpcServer } from '../src/server.ts';
import type { RpcTransport } from '../src/types.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

function defineUsers() {
  @RpcMessage()
  class GetUserRequest {
    @RpcField(1)
    id!: string;
  }

  @RpcMessage()
  class User {
    @RpcField(1)
    id!: string;

    @RpcField(2)
    name!: string;
  }

  @RpcService({ package: 'gaps.v1' })
  class UserService {
    @RpcMethod({ input: () => GetUserRequest, output: () => User })
    get(request: GetUserRequest): User {
      return { id: request.id, name: 'Ada' };
    }

    @RpcMethod({ input: () => GetUserRequest, output: () => User })
    fail(_request: GetUserRequest): User {
      throw new Error('plain failure');
    }
  }

  return { GetUserRequest, User, UserService };
}

describe('memoryPair - simulated latency', () => {
  it('delays delivery by delayMs before invoking peer handlers', async () => {
    const pair = memoryPair({ delayMs: 5 });
    const received: unknown[] = [];
    pair.serverTransport.subscribe((payload) => {
      received.push(payload);
    });
    const start = Date.now();
    await pair.clientTransport.send({ hello: 'world' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
    expect(received).toEqual([{ hello: 'world' }]);
  });
});

describe('server.ts - started getter and error handling', () => {
  it('reflects started state across start()/stop() and reports transport.send() failures via onError', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const errors: unknown[] = [];
    const failingTransport: RpcTransport = {
      ...pair.serverTransport,
      async send() {
        throw new Error('send exploded');
      },
    };
    const server = createRpcServer({
      transport: failingTransport,
      onError: (error) => errors.push(error),
    });

    expect(server.started).toBe(false);
    await server.start();
    expect(server.started).toBe(true);

    // Trigger the server's subscribe handler via the paired client transport,
    // producing a response the (failing) transport.send() will reject.
    await pair.clientTransport.send({
      jsonrpc: '2.0',
      id: '1',
      method: 'gaps.v1.UserService/Get',
      params: { id: '1' },
    });
    await Bun.sleep(10);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('send exploded');

    await server.stop();
    expect(server.started).toBe(false);

    // Calling stop() again while not started is a no-op.
    await server.stop();
    void UserService;
  });
});

describe('dispatcher.ts - malformed payload & not-callable branches', () => {
  it('rejects an empty batch and a batch with an invalid call', async () => {
    const dispatcher = createRpcDispatcher();
    await expect(dispatcher.dispatch([])).resolves.toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: 'Invalid Request' }) }),
    ]);
    await expect(dispatcher.dispatch([{ garbage: true }])).resolves.toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: 'Invalid Request' }) }),
    ]);
  });

  it('rejects a non-array, non-call single payload', async () => {
    const dispatcher = createRpcDispatcher();
    await expect(dispatcher.dispatch({ garbage: true })).resolves.toEqual(
      expect.objectContaining({ error: expect.objectContaining({ message: 'Invalid Request' }) }),
    );
  });

  it('returns a server error when the resolved method handler is not callable', async () => {
    const { UserService } = defineUsers();
    const instance = useContainer().resolve(UserService) as unknown as Record<string, unknown>;
    instance.get = undefined;

    const dispatcher = createRpcDispatcher();
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'gaps.v1.UserService/Get',
      params: { id: '1' },
    });
    expect(response).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringContaining('is not callable') }),
      }),
    );
  });
});

describe('http.ts - transport & handler edge cases', () => {
  it('throws when the HTTP response is not ok', async () => {
    const transport = httpTransport({
      url: 'http://x.test/rpc',
      fetch: async () => new Response('nope', { status: 500, statusText: 'Server Error' }),
    });
    await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow(
      /HTTP RPC failed with 500/,
    );
  });

  it('supports subscribe()/unsubscribe() and stop() clearing handlers', async () => {
    let received: unknown;
    const transport = httpTransport({
      url: 'http://x.test/rpc',
      fetch: async () => Response.json({ jsonrpc: '2.0', id: '1', result: { ok: true } }),
    });
    const unsub = transport.subscribe((payload) => {
      received = payload;
    });
    await transport.send({ jsonrpc: '2.0', id: '1', method: 'x' });
    expect(received).toEqual({ jsonrpc: '2.0', id: '1', result: { ok: true } });

    unsub();
    received = undefined;
    await transport.send({ jsonrpc: '2.0', id: '2', method: 'x' });
    expect(received).toBeUndefined();

    await transport.stop?.();
  });

  it('rejects non-POST requests with 405 and includes an Allow header', async () => {
    const handler = createHttpRpcHandler();
    const response = await handler(new Request('http://x.test/rpc', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('returns 404 for a mismatched path', async () => {
    const handler = createHttpRpcHandler({ path: '/custom' });
    const response = await handler(
      new Request('http://x.test/rpc', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(404);
  });

  it('returns a JSON-RPC parse error when request.text() throws', async () => {
    const handler = createHttpRpcHandler();
    const fakeRequest = {
      url: 'http://x.test/rpc',
      method: 'POST',
      async text() {
        throw new Error('body already consumed');
      },
    } as unknown as Request;
    const response = await handler(fakeRequest);
    const body = await response.json();
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('returns 204 No Content when dispatch completes with no response (notification)', async () => {
    const handler = createHttpRpcHandler();
    const response = await handler(
      new Request('http://x.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'nonexistentNotification',
        }),
      }),
    );
    expect(response.status).toBe(204);
  });

  it('handles dispatcher rejection gracefully in createHttpRpcHandler', async () => {
    defineUsers();
    const handler = createHttpRpcHandler({
      interceptors: [
        () => {
          throw new Error('interceptor panic');
        },
      ],
    });
    const response = await handler(
      new Request('http://x.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'gaps.v1.UserService/Get',
          params: { id: '1' },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('interceptor panic');
  });

  it('handles container resolution failure rejection in createHttpRpcHandler', async () => {
    defineUsers();
    const customContainer = {
      resolve() {
        throw new Error('DI container failure');
      },
    };
    const handler = createHttpRpcHandler({ container: customContainer as never });
    const response = await handler(
      new Request('http://x.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'gaps.v1.UserService/Get',
          params: { id: '1' },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('DI container failure');
  });
});

describe('grpc.ts - error mapping, JSON-RPC code translation, and transport lifecycle', () => {
  it('maps a plain (non-RpcAppError) thrown error to ConnectError Internal via createGrpcRoutes', async () => {
    const { UserService } = defineUsers();
    const connect = createRouterTransport(createGrpcRoutes());
    const client = createRpcClient(UserService, grpcTransport({ transport: connect }));
    await expect(client.fail({ id: '1' })).rejects.toMatchObject({
      data: { connectCode: Code.Internal },
    });
  });

  it('throws "is not callable" as an Internal ConnectError when the resolved handler is missing', async () => {
    const { UserService } = defineUsers();
    const instance = useContainer().resolve(UserService) as unknown as Record<string, unknown>;
    instance.get = undefined;

    const connect = createRouterTransport(createGrpcRoutes());
    const client = createRpcClient(UserService, grpcTransport({ transport: connect }));
    await expect(client.get({ id: '1' })).rejects.toMatchObject({
      data: { connectCode: Code.Internal },
    });
  });

  it('maps InvalidArgument and Canceled connect codes to the right JSON-RPC codes', async () => {
    const { RpcAppError } = await import('../src/errors.ts');
    const { JSON_RPC_ERRORS } = await import('../src/codec.ts');
    const { RPC_CONNECT_CODES } = await import('../src/errors.ts');

    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    @RpcMessage()
    class Res {
      @RpcField(1)
      id!: string;
    }
    @RpcService({ package: 'codes.v1' })
    class CodesService {
      @RpcMethod({ input: () => Req, output: () => Res })
      invalidArg(): Res {
        throw new RpcAppError('bad arg', { connectCode: RPC_CONNECT_CODES.INVALID_ARGUMENT });
      }

      @RpcMethod({ input: () => Req, output: () => Res })
      canceled(): Res {
        throw new RpcAppError('canceled op', { connectCode: RPC_CONNECT_CODES.CANCELED });
      }
    }

    const connect = createRouterTransport(createGrpcRoutes());
    const client = createRpcClient(CodesService, grpcTransport({ transport: connect }));

    try {
      await client.invalidArg({ id: '1' });
      expect.unreachable('expected rejection');
    } catch (error) {
      expect((error as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      expect((error as { data: unknown }).data).toEqual({ connectCode: Code.InvalidArgument });
    }

    try {
      await client.canceled({ id: '1' });
      expect.unreachable('expected rejection');
    } catch (error) {
      expect((error as { code: number }).code).toBe(JSON_RPC_ERRORS.SERVER);
      expect((error as { data: unknown }).data).toEqual({ connectCode: Code.Canceled });
    }
  });

  it('returns undefined and skips send() when a notification-only gRPC call yields no responses', async () => {
    @RpcMessage()
    class Ping {
      @RpcField(1)
      value!: string;
    }
    @RpcService({ package: 'notify.v1' })
    class NotifyService {
      @RpcMethod({ input: () => Ping, output: () => Ping })
      go(request: Ping): Ping {
        return request;
      }
    }
    void NotifyService;

    const connect = createRouterTransport(createGrpcRoutes());
    const transport = grpcTransport({ transport: connect });
    // Method not found + no id (notification-shaped call): resolves without throwing.
    await expect(
      transport.send({ jsonrpc: '2.0', method: 'notify.v1.NotifyService/Missing' }),
    ).resolves.toBeUndefined();
  });

  it('throws for non-JSON-RPC payloads and returns method-not-found for unmatched calls with an id', async () => {
    const connect = createRouterTransport(createGrpcRoutes());
    const transport = grpcTransport({ transport: connect });
    await expect(transport.send({ not: 'jsonrpc' } as never)).rejects.toThrow(
      /JSON-RPC calls only/,
    );

    const responses: unknown[] = [];
    transport.subscribe((payload) => {
      responses.push(payload);
    });
    await transport.send({
      jsonrpc: '2.0',
      id: '9',
      method: 'gaps.v1.UserService/Missing',
      params: {},
    });
    expect(responses).toEqual([
      expect.objectContaining({
        id: '9',
        error: expect.objectContaining({ message: 'Method not found' }),
      }),
    ]);
  });

  it('supports subscribe()/unsubscribe() and stop() clearing handlers', async () => {
    defineUsers();
    const connect = createRouterTransport(createGrpcRoutes());
    const transport = grpcTransport({ transport: connect });
    let calls = 0;
    const unsub = transport.subscribe(() => {
      calls += 1;
    });
    await transport.send({
      jsonrpc: '2.0',
      id: '1',
      method: 'gaps.v1.UserService/Get',
      params: { id: '1' },
    });
    expect(calls).toBe(1);
    unsub();
    await transport.stop?.();
  });

  it('chains multiple server-side interceptors through composeServerInterceptors', async () => {
    const { UserService } = defineUsers();
    const order: string[] = [];
    const connect = createRouterTransport(
      createGrpcRoutes({
        interceptors: [
          async (_ctx, next) => {
            order.push('first-before');
            const result = await next();
            order.push('first-after');
            return result;
          },
          async (_ctx, next) => {
            order.push('second-before');
            const result = await next();
            order.push('second-after');
            return result;
          },
        ],
      }),
    );
    const client = createRpcClient(UserService, grpcTransport({ transport: connect }));
    await expect(client.get({ id: '1' })).resolves.toEqual({ id: '1', name: 'Ada' });
    expect(order).toEqual(['first-before', 'second-before', 'second-after', 'first-after']);
  });
});
