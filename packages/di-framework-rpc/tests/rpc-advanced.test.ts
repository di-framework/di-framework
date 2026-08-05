import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Code, createRouterTransport } from '@connectrpc/connect';
import { useContainer } from '@di-framework/core/container';
import type { SocketConnection } from '@di-framework/socket';
import {
  createMemoryDuplexPair,
  type MessageDuplex,
  textFrame,
  toFrame,
} from '@di-framework/socket';
import {
  compileConnectSchema,
  createGrpcHandler,
  createGrpcRoutes,
  grpcTransport,
} from '../grpc.ts';
import {
  createRpcClient,
  createRpcDispatcher,
  createRpcServer,
  decodeRpcMessage,
  encodeRpcMessage,
  JSON_RPC_ERRORS,
  memoryPair,
  RPC_CONNECT_CODES,
  RpcAppError,
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcNotify,
  RpcRemoteError,
  RpcService,
  registry,
} from '../index.ts';
import { socketTransport } from '../socket.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

function duplexAsConnection(duplex: MessageDuplex, id: string): SocketConnection {
  return {
    id,
    protocol: 'websocket',
    securityMode: 'plain',
    send(data) {
      return duplex.send(typeof data === 'string' ? textFrame(data) : toFrame(data));
    },
    close(code, reason) {
      duplex.close?.(code, reason);
    },
    onMessage(handler) {
      return duplex.onMessage((frame) => {
        void handler(frame);
      });
    },
    onClose() {
      return () => undefined;
    },
  };
}

function defineUsers(failWithAppError = false) {
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

  @RpcService({ package: 'example.v1' })
  class UserService {
    touched: string[] = [];

    @RpcMethod({ input: () => GetUserRequest, output: () => User })
    get(request: GetUserRequest): User {
      return { id: request.id, name: 'Ada' };
    }

    @RpcNotify({ input: () => GetUserRequest })
    touch(request: GetUserRequest): void {
      this.touched.push(request.id);
    }

    @RpcMethod({ input: () => GetUserRequest, output: () => User })
    fail(_request: GetUserRequest): User {
      if (failWithAppError) {
        throw new RpcAppError('missing user', {
          code: JSON_RPC_ERRORS.SERVER,
          connectCode: RPC_CONNECT_CODES.NOT_FOUND,
          data: { id: 'missing' },
        });
      }
      throw new Error('no user');
    }
  }

  return { GetUserRequest, User, UserService };
}

describe('socket transport', () => {
  it('round-trips JSON-RPC over a @di-framework/socket duplex', async () => {
    const { UserService } = defineUsers();
    const { left, right } = createMemoryDuplexPair();
    const server = createRpcServer({
      transport: socketTransport(duplexAsConnection(left, 'server')),
    });
    await server.start();
    const client = createRpcClient(
      UserService,
      socketTransport(duplexAsConnection(right, 'client')),
    );

    await expect(client.get({ id: 'sock-1' })).resolves.toEqual({
      id: 'sock-1',
      name: 'Ada',
    });
    await client.touch({ id: 'sock-1' });
    expect(useContainer().resolve(UserService).touched).toEqual(['sock-1']);
    await server.stop();
  });
});

describe('live gRPC handler', () => {
  it('serves createGrpcHandler over node:http', async () => {
    const { UserService } = defineUsers();
    const handler = createGrpcHandler();
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const client = createRpcClient(
        UserService,
        grpcTransport({ baseUrl: `http://127.0.0.1:${port}` }),
      );
      await expect(client.get({ id: 'live-1' })).resolves.toEqual({
        id: 'live-1',
        name: 'Ada',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('client batch, abort, and interceptors', () => {
  it('sends a JSON-RPC batch via $batch', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(UserService, pair.clientTransport);

    const [first, second] = await client.$batch((rpc) => [
      rpc.get({ id: 'a' }),
      rpc.get({ id: 'b' }),
    ]);
    expect(first).toEqual({ id: 'a', name: 'Ada' });
    expect(second).toEqual({ id: 'b', name: 'Ada' });
    await server.stop();
  });

  it('aborts an in-flight call via AbortSignal', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    // Deliberately do not start a server so the call stays pending.
    const controller = new AbortController();
    const client = createRpcClient(UserService, pair.clientTransport, {
      signal: controller.signal,
    });
    const pending = client.get({ id: '1' });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('runs client and server interceptors', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const seen: string[] = [];
    const server = createRpcServer({
      transport: pair.serverTransport,
      interceptors: [
        async (ctx, next) => {
          seen.push(`server:${ctx.method}`);
          return next();
        },
      ],
    });
    await server.start();
    const client = createRpcClient(UserService, pair.clientTransport, {
      interceptors: [
        async (ctx, next) => {
          seen.push(`client:${ctx.method}`);
          if (ctx.params && typeof ctx.params === 'object') {
            (ctx.params as { id: string }).id = `x-${(ctx.params as { id: string }).id}`;
          }
          return next();
        },
      ],
    });

    await expect(client.get({ id: '9' })).resolves.toEqual({ id: 'x-9', name: 'Ada' });
    expect(seen).toEqual([
      'client:example.v1.UserService/Get',
      'server:example.v1.UserService/Get',
    ]);
    await server.stop();
  });

  it('honors per-call timeoutMs', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const client = createRpcClient(UserService, pair.clientTransport);
    await expect(client.get({ id: '1' }, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
  });
});

describe('structured RPC errors', () => {
  it('maps RpcAppError to JSON-RPC codes and data', async () => {
    defineUsers(true);
    const response = await createRpcDispatcher().dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'example.v1.UserService/Fail',
      params: { id: 'missing' },
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: JSON_RPC_ERRORS.SERVER,
        message: 'missing user',
        data: { id: 'missing' },
      },
    });
  });

  it('maps RpcAppError connectCode through gRPC', async () => {
    const { UserService } = defineUsers(true);
    const connect = createRouterTransport(createGrpcRoutes());
    const client = createRpcClient(UserService, grpcTransport({ transport: connect }));
    try {
      await client.fail({ id: 'missing' });
      expect.unreachable('expected RpcRemoteError');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcRemoteError);
      const remote = error as RpcRemoteError;
      expect(remote.message).toBe('missing user');
      expect(remote.data).toEqual({ connectCode: Code.NotFound });
    }
  });
});

describe('codec parity with protobuf-es', () => {
  it('round-trips the same bytes as @bufbuild/protobuf', () => {
    @RpcMessage()
    class Address {
      @RpcField(1)
      city!: string;
    }

    @RpcMessage()
    class Profile {
      @RpcField(1)
      name!: string;

      @RpcField({ number: 2, type: 'int32' })
      age!: number;

      @RpcField({ number: 3, type: 'bool' })
      active!: boolean;

      @RpcField({ number: 4, type: 'double' })
      score!: number;

      @RpcField({ number: 5, type: 'bytes' })
      token!: Uint8Array;

      @RpcField({ number: 6, type: () => Address, repeated: true })
      addresses!: Address[];
    }

    @RpcService({ package: 'codec.v1' })
    class Profiles {
      @RpcMethod({ input: () => Profile, output: () => Profile })
      save(profile: Profile): Profile {
        return profile;
      }
    }
    void Profiles;

    const value = {
      name: 'Ada',
      age: 37,
      active: true,
      score: 1.5,
      token: new Uint8Array([1, 2, 3, 4]),
      addresses: [{ city: 'London' }, { city: 'Paris' }],
    };

    const handrolled = encodeRpcMessage(Profile, value);
    const schema = compileConnectSchema();
    const desc = schema.messages.get('codec.v1.Profile');
    expect(desc).toBeDefined();
    if (!desc) return;

    const fromHand = fromBinary(desc, handrolled);
    expect([...toBinary(desc, fromHand)]).toEqual([...handrolled]);

    const connectMsg = create(desc, {
      name: value.name,
      age: value.age,
      active: value.active,
      score: value.score,
      token: value.token,
      addresses: value.addresses,
    });
    const connectBytes = toBinary(desc, connectMsg);
    expect([...handrolled]).toEqual([...connectBytes]);

    const decoded = decodeRpcMessage(Profile, connectBytes);
    expect(decoded.name).toBe('Ada');
    expect(decoded.age).toBe(37);
    expect(decoded.active).toBe(true);
    expect(decoded.score).toBe(1.5);
    expect([...decoded.token]).toEqual([1, 2, 3, 4]);
    expect(decoded.addresses.map((address) => address.city)).toEqual(['London', 'Paris']);
  });
});
