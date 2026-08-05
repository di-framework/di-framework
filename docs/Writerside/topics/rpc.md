# RPC

Decorator-centric **JSON-RPC 2.0** and **per-method gRPC** for `@di-framework/core`. The decorators are the schema: the same service runs over memory, HTTP, sockets, and Connect / gRPC-Web / native gRPC with **no application `.proto` generation**.

> **Wire RPC, not the in-process bus.** Core `@Publisher` / `@Subscriber` and [`@di-framework/events`](events.md) move messages inside a process or to brokers. `@di-framework/rpc` exposes **typed request/response methods** to callers over a transport — a local-feeling client proxy backed by JSON-RPC or gRPC.

## Features

- **Decorators are the schema**: `@RpcMessage` / `@RpcField` declare protobuf-shaped types at runtime; `@RpcService` / `@RpcMethod` / `@RpcNotify` expose methods — no app `protoc`.
- **Typed client proxy**: `createRpcClient(Service, transport)` returns `await client.get({ id })` with full inference.
- **Pluggable transports**: memory (tests), HTTP (`fetch` / `Request`), `@di-framework/socket`, and per-method gRPC via Connect.
- **Per-method gRPC**: each `@RpcMethod` becomes a real unary RPC at `/package.Service/Method`, served by Connect, gRPC-Web, and native gRPC.
- **Batching, cancellation, interceptors**: `$batch(...)`, per-call `{ signal, timeoutMs }`, and client/server interceptors for auth, logging, and deadlines.
- **Structured errors**: throw `RpcAppError` to control JSON-RPC codes and Connect/gRPC codes.
- **DI-native lifecycle**: services resolve from the container; pass a transport to auto-start on resolve, or bootstrap all services together.

## Installation

```bash
bun add @di-framework/rpc @di-framework/core
```

For gRPC (optional peers):

```bash
bun add @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

For sockets (optional peer):

```bash
bun add @di-framework/socket
```

Decorators need TypeScript 5 and `experimentalDecorators`. No `reflect-metadata` — nested and repeated fields use an explicit factory (`type: () => Other`).

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

`get` becomes the protobuf RPC `/example.v1.UserService/Get` and the JSON-RPC method `example.v1.UserService/Get`.

Supported v1 scalar types are `string`, `bool`, `int32`, `int64`, `double`, and `bytes`. Nested and repeated messages use an explicit factory:

```typescript
@RpcField({ number: 4, type: () => Address, repeated: true })
addresses!: Address[];
```

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
```

Type-only construction cannot discover a service path after TypeScript erases generics. When the class is unavailable, provide it explicitly:

```typescript
const users = createRpcClient<UserService>(transport, {
  service: 'example.v1.UserService',
});
```

## Batching, cancellation, and interceptors

```typescript
// One JSON-RPC array carrying multiple calls:
const [a, b] = await users.$batch((rpc) => [
  rpc.get({ id: '1' }),
  rpc.get({ id: '2' }),
]);

// Per-call abort / timeout:
const ac = new AbortController();
await users.get({ id: '1' }, { signal: ac.signal, timeoutMs: 5_000 });
```

Interceptors wrap each call on either side — useful for auth headers, logging, and deadlines:

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
  transport: serverTransport,
  interceptors: [async (ctx, next) => next()],
});
```

## Structured errors

Throw `RpcAppError` from a method to control the JSON-RPC error code and the Connect/gRPC code together. A plain `Error` maps to JSON-RPC `-32000` / Connect `internal`.

```typescript
import { RpcAppError, RPC_CONNECT_CODES } from '@di-framework/rpc';

@RpcMethod({ input: () => GetUserRequest, output: () => User })
get(request: GetUserRequest): User {
  const user = this.repo.find(request.id);
  if (!user) {
    throw new RpcAppError('user not found', {
      connectCode: RPC_CONNECT_CODES.NOT_FOUND,
      data: { id: request.id },
    });
  }
  return user;
}
```

The client rejects with `RpcRemoteError` carrying `code`, `message`, and `data`.

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

The HTTP endpoint supports JSON-RPC batches, notifications, and standard error codes. `createHttpRpcHandler` accepts `interceptors` for server-side wrapping.

## Sockets

Adapt an established secure or plain [`@di-framework/socket`](socket.md) connection:

```typescript
import { socketTransport } from '@di-framework/rpc/socket';
import { createRpcClient } from '@di-framework/rpc';

const users = createRpcClient(UserService, socketTransport(connection));
```

JSON-RPC frames ride as **text** frames, composing with the socket secure channel.

## Per-method gRPC / Connect

```typescript
import { createServer } from 'node:http';
import { createGrpcHandler, grpcTransport } from '@di-framework/rpc/grpc';
import { createRpcClient } from '@di-framework/rpc';

const handler = createGrpcHandler(); // Connect + gRPC-Web + native gRPC
createServer(handler).listen(3000);

const users = createRpcClient(
  UserService,
  grpcTransport({ baseUrl: 'http://localhost:3000' }),
);
await users.get({ id: '1' });
```

The adapter builds protobuf-es descriptors at runtime, so every `@RpcMethod` is a real unary service method — not a generic JSON envelope. `RpcAppError.connectCode` is mapped to the matching Connect `Code`, and Connect errors map back to JSON-RPC codes on the client.

Inspect or export the generated IDL (one file per package, scoped to the messages each package reaches):

```typescript
import { printProto } from '@di-framework/rpc';

console.log(printProto());
```

## Lifecycle

Pass a transport to `@RpcService` to auto-start when DI resolves the service, or bootstrap all services on one transport:

```typescript
import { startRpcServices, stopRpcServices } from '@di-framework/rpc';

await startRpcServices({ transport });
await stopRpcServices();
```

## Choosing a transport

| Transport | Import | Use |
| --- | --- | --- |
| memory | `@di-framework/rpc` (`memoryPair`) | Tests, in-process |
| HTTP | `@di-framework/rpc/http` | Fetch / `Request` servers (Bun, Workers, Node) |
| socket | `@di-framework/rpc/socket` | Long-lived WebSocket / TCP peers |
| gRPC | `@di-framework/rpc/grpc` | Connect, gRPC-Web, native gRPC clients |

## Related

- [Events](events.md) — in-process bus and broker bridge (fire-and-forget, not request/response)
- [Sockets](socket.md) — the secure wire transport reused by `@di-framework/rpc/socket`
- [HTTP Router](http-router.md) — REST + OpenAPI; RPC is method-oriented instead
- [Authentication](auth.md) — identity to enforce inside RPC interceptors
