# @di-framework/rpc

Decorator-centric JSON-RPC 2.0 and per-method gRPC for
[`@di-framework/core`](https://github.com/di-framework/di-framework).
Decorators are the schema: the same service runs over memory, HTTP, sockets,
Connect, gRPC-Web, and native gRPC without application `.proto` generation.

## Install

```bash
bun add @di-framework/rpc @di-framework/core
```

For gRPC:

```bash
bun add @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

For sockets:

```bash
bun add @di-framework/socket
```

## Define messages and a service

```typescript
import {
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcNotify,
  RpcService,
} from '@di-framework/rpc';

@RpcMessage()
class GetUserRequest {
  // Numeric shorthand defaults to a string field.
  @RpcField(1)
  id!: string;
}

@RpcMessage()
class User {
  @RpcField(1)
  id!: string;

  @RpcField(2)
  name!: string;

  @RpcField({ number: 3, type: 'int32' })
  loginCount!: number;
}

@RpcService({ package: 'example.v1' })
class UserService {
  @RpcMethod({ input: () => GetUserRequest, output: () => User })
  get(request: GetUserRequest): User {
    return { id: request.id, name: 'Ada', loginCount: 1 };
  }

  @RpcNotify({ input: () => GetUserRequest })
  touched(request: GetUserRequest): void {
    console.log(request.id);
  }
}
```

`get` becomes the first-class protobuf RPC
`/example.v1.UserService/Get` and the JSON-RPC method
`example.v1.UserService/Get`.

Nested and repeated messages use an explicit factory because the package does
not require `emitDecoratorMetadata`:

```typescript
@RpcField({ number: 4, type: () => Address, repeated: true })
addresses!: Address[];
```

Supported v1 scalar types are `string`, `bool`, `int32`, `int64`, `double`,
and `bytes`.

## Typed client and memory transport

```typescript
import {
  createRpcClient,
  createRpcServer,
  memoryPair,
} from '@di-framework/rpc';

const { clientTransport, serverTransport } = memoryPair();
const server = createRpcServer({ transport: serverTransport });
await server.start();

// Passing the decorated class supplies the runtime service path while the
// returned proxy preserves method arguments and results.
const users = createRpcClient(UserService, clientTransport);
const user = await users.get({ id: '1' });
await users.touched({ id: '1' });

// Batch multiple calls into one JSON-RPC array:
const [a, b] = await users.$batch((rpc) => [
  rpc.get({ id: '1' }),
  rpc.get({ id: '2' }),
]);

// Abort / timeout a single call:
const ac = new AbortController();
await users.get({ id: '1' }, { signal: ac.signal, timeoutMs: 5_000 });
```

Client and server interceptors wrap each call (useful for auth, logging, deadlines):

```typescript
const users = createRpcClient(UserService, clientTransport, {
  interceptors: [
    async (ctx, next) => {
      console.log(ctx.method);
      return next();
    },
  ],
});

createRpcServer({
  transport,
  interceptors: [
    async (ctx, next) => next(),
  ],
});
```

Throw `RpcAppError` from a method to control JSON-RPC and Connect codes:

```typescript
import { RpcAppError, RPC_CONNECT_CODES } from '@di-framework/rpc';

throw new RpcAppError('missing user', {
  connectCode: RPC_CONNECT_CODES.NOT_FOUND,
  data: { id },
});
```

Type-only construction cannot discover a service path after TypeScript erases
generics. When the class is unavailable, provide it explicitly:

```typescript
const users = createRpcClient<UserService>(transport, {
  service: 'example.v1.UserService',
});
```

## HTTP

```typescript
import { createHttpRpcHandler, httpTransport } from '@di-framework/rpc/http';
import { createRpcClient } from '@di-framework/rpc';

const rpc = createHttpRpcHandler({ path: '/rpc' });
Bun.serve({ fetch: rpc });

const users = createRpcClient(
  UserService,
  httpTransport({ url: 'http://localhost:3000/rpc' }),
);
```

The HTTP endpoint supports JSON-RPC batches, notifications, and standard error
codes.

## Per-method gRPC / Connect

```typescript
import { createServer } from 'node:http2';
import { createGrpcHandler, grpcTransport } from '@di-framework/rpc/grpc';
import { createRpcClient } from '@di-framework/rpc';

const handler = createGrpcHandler();
createServer(handler).listen(3000);

const users = createRpcClient(
  UserService,
  grpcTransport({ baseUrl: 'http://localhost:3000' }),
);
```

The adapter builds protobuf-es descriptors at runtime. Every `@RpcMethod` is a
real unary service method served by Connect, gRPC-Web, and native gRPC. It is
not a generic JSON envelope.

Inspect or export the generated IDL:

```typescript
import { printProto } from '@di-framework/rpc';

console.log(printProto());
```

## Socket

Adapt an established secure or plain `@di-framework/socket` connection:

```typescript
import { socketTransport } from '@di-framework/rpc/socket';

const users = createRpcClient(UserService, socketTransport(connection));
```

## Lifecycle

Pass a transport to `@RpcService` to auto-start when DI resolves the service,
or bootstrap all services on one transport:

```typescript
await startRpcServices({ transport });
await stopRpcServices();
```
