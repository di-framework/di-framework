import { beforeEach, describe, expect, it } from 'bun:test';
import { createRouterTransport } from '@connectrpc/connect';
import { useContainer } from '@di-framework/core/container';
import { createGrpcRoutes, grpcTransport } from '../grpc.ts';
import { createHttpRpcHandler, httpTransport } from '../http.ts';
import {
  createRpcClient,
  createRpcDispatcher,
  createRpcServer,
  decodeRpcMessage,
  encodeRpcMessage,
  JSON_RPC_ERRORS,
  memoryPair,
  parseJsonRpc,
  printProto,
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcNotify,
  RpcRemoteError,
  RpcService,
  registry,
} from '../index.ts';

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
      throw new Error('no user');
    }
  }

  return { GetUserRequest, User, UserService };
}

describe('message schema', () => {
  it('encodes protobuf binary and prints per-method proto', () => {
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

      @RpcField({ number: 3, type: () => Address, repeated: true })
      addresses!: Address[];
    }

    @RpcService({ package: 'profile.v1' })
    class Profiles {
      @RpcMethod({ input: () => Profile, output: () => Profile })
      save(profile: Profile): Profile {
        return profile;
      }
    }

    void Profiles;
    const encoded = encodeRpcMessage(Profile, {
      name: 'Ada',
      age: 37,
      addresses: [{ city: 'London' }, { city: 'Paris' }],
    });
    const decoded = decodeRpcMessage(Profile, encoded);

    expect(decoded).toBeInstanceOf(Profile);
    expect(decoded.name).toBe('Ada');
    expect(decoded.age).toBe(37);
    expect(decoded.addresses.map((address) => address.city)).toEqual(['London', 'Paris']);
    expect(printProto()).toContain('rpc Save (Profile) returns (Profile);');
    expect(printProto()).toContain('repeated Address addresses = 3;');
  });
});

describe('JSON-RPC transports', () => {
  it('returns standard parse and method-not-found errors', async () => {
    expect(parseJsonRpc('{')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.PARSE, message: 'Parse error' },
    });

    const response = await createRpcDispatcher().dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'missing.v1.Service/Get',
      params: {},
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        message: 'Method not found',
      },
    });
  });

  it('auto-starts a decorator transport when DI resolves the service', async () => {
    const pair = memoryPair();

    @RpcMessage()
    class Ping {
      @RpcField(1)
      value!: string;
    }

    @RpcService({ package: 'health.v1', transport: pair.serverTransport })
    class HealthService {
      @RpcMethod({ input: () => Ping, output: () => Ping })
      ping(request: Ping): Ping {
        return request;
      }
    }

    useContainer().resolve(HealthService);
    await Bun.sleep(0);
    const client = createRpcClient(HealthService, pair.clientTransport);
    await expect(client.ping({ value: 'ok' })).resolves.toEqual({ value: 'ok' });
  });

  it('round-trips typed calls and notifications over memory', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(UserService, pair.clientTransport);

    await expect(client.get({ id: '7' })).resolves.toEqual({
      id: '7',
      name: 'Ada',
    });
    await client.touch({ id: '7' });

    const service = useContainer().resolve(UserService);
    expect(service.touched).toEqual(['7']);
    await server.stop();
  });

  it('maps method failures to typed remote errors', async () => {
    const { UserService } = defineUsers();
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(UserService, pair.clientTransport);

    await expect(client.fail({ id: 'missing' })).rejects.toBeInstanceOf(RpcRemoteError);
    await server.stop();
  });

  it('dispatches JSON-RPC batches and omits notification responses', async () => {
    defineUsers();
    const dispatcher = createRpcDispatcher();
    const response = await dispatcher.dispatch([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'example.v1.UserService/Get',
        params: { id: '1' },
      },
      {
        jsonrpc: '2.0',
        method: 'example.v1.UserService/Touch',
        params: { id: '2' },
      },
    ]);

    expect(response).toEqual([{ jsonrpc: '2.0', id: 1, result: { id: '1', name: 'Ada' } }]);
  });

  it('serves the same registry over HTTP', async () => {
    const { UserService } = defineUsers();
    const handler = createHttpRpcHandler();
    const transport = httpTransport({
      url: 'http://rpc.test/rpc',
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const client = createRpcClient(UserService, transport);

    await expect(client.get({ id: '9' })).resolves.toEqual({
      id: '9',
      name: 'Ada',
    });
  });
});

describe('per-method gRPC', () => {
  it('builds real service methods and round-trips through Connect', async () => {
    const { UserService } = defineUsers();
    const connect = createRouterTransport(createGrpcRoutes());
    const transport = grpcTransport({ transport: connect });
    const client = createRpcClient(UserService, transport);

    await expect(client.get({ id: '11' })).resolves.toEqual({
      id: '11',
      name: 'Ada',
    });
    expect(printProto()).toContain('service UserService');
    expect(printProto()).toContain('rpc Get (GetUserRequest) returns (User);');
  });
});

describe('multi-package schema scoping', () => {
  it('emits only the messages reachable from each package', () => {
    @RpcMessage()
    class OrderId {
      @RpcField(1)
      id!: string;
    }

    @RpcMessage()
    class Invoice {
      @RpcField(1)
      total!: string;
    }

    @RpcService({ package: 'billing.v1' })
    class BillingService {
      @RpcMethod({ input: () => OrderId, output: () => Invoice })
      lookup(request: OrderId): Invoice {
        return { total: request.id };
      }
    }

    @RpcMessage()
    class Shipment {
      @RpcField(1)
      tracking!: string;
    }

    @RpcService({ package: 'shipping.v1' })
    class ShippingService {
      @RpcMethod({ input: () => OrderId, output: () => Shipment })
      track(request: OrderId): Shipment {
        return { tracking: request.id };
      }
    }

    void BillingService;
    void ShippingService;

    const proto = printProto();
    const [billingFile, shippingFile] = proto.split('// ---- next generated file ----');

    expect(billingFile).toContain('package billing.v1;');
    expect(billingFile).toContain('message Invoice');
    expect(billingFile).not.toContain('message Shipment');

    expect(shippingFile).toContain('package shipping.v1;');
    expect(shippingFile).toContain('message Shipment');
    expect(shippingFile).not.toContain('message Invoice');
  });
});
