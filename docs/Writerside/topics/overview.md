# DI Framework

A lightweight, type-safe dependency injection framework for TypeScript, plus companion packages for common application concerns. The core automatically manages service instantiation, dependency resolution, and lifecycle management.

## Features

- **Zero Dependencies**: No external dependencies required. Works with SWC and TypeScript's native decorator support.
- **Type-Safe**: Full TypeScript support with type inference for all injected dependencies.
- **Automatic Resolution**: Dependencies are automatically resolved and injected.
- **Lifecycle Management**: Built-in support for singleton and transient service lifecycles.
- **Factory Functions**: Register services using factory functions for complex initialization.
- **Event-Driven**: Decouple service communication with `@Publisher` and `@Subscriber` decorators.
- **Telemetry**: Built-in support for method tracking and monitoring with `@Telemetry` and `@TelemetryListener`.
- **Error Detection**: Detects circular dependencies and unregistered services at runtime.
- **Testing Support**: Easy to test with mock service registration.
- **Repository Abstraction**: Includes `@di-framework/repo` for standardized data access and storage-agnostic repositories.
- **HTTP Routing & OpenAPI**: Type-safe HTTP routing and build-time OpenAPI 3.1 generation with `@di-framework/http`.
- **GraphQL**: Object-oriented, decorator-driven GraphQL with `@di-framework/graphql` — domain classes become the schema.
- **Events**: Bridge `@Publisher` / `@Subscriber` to Kafka, NATS, or in-memory transports with `@di-framework/events`.
- **Configuration**: Typed, validated config from env/files injected via DI with `@di-framework/config`.
- **Authentication**: Sessions, JWT, OAuth2/OIDC, and WebAuthn passkeys on WebCrypto with `@di-framework/auth` — zero runtime dependencies.
- **Resource Authorization**: Decorator-authored policies, EBNF interchange, DI resource providers, and fail-closed HTTP controller bindings with `@di-framework/authz`.
- **Sockets**: Security-first WebSocket, TCP, and UDP with a WebCrypto secure channel via `@di-framework/socket` (network I/O — distinct from the in-process event bus).
- **RPC**: Decorator-generated JSON-RPC and per-method gRPC with a typed client via `@di-framework/rpc` — the same service over memory, HTTP, sockets, and Connect / gRPC.
- **AI**: Annotation-driven chat, tools, RAG, MCP, and agents with `@di-framework/ai` (OpenAI-compatible and Anthropic HTTP adapters).
- **App CLI**: Scaffold, typecheck, and build apps with `@di-framework/cli` (`init`, `check`, `build`); monorepo maintainers use `mx`.
- **Runtime type checks**: `ttsc` transform `@di-framework/tsc` injects parameter guards from TypeScript types at emit time (`di-framework init` wires this by default).

## Why Use This Framework?

Traditional dependency injection requires manual service instantiation and wiring, which becomes error-prone and difficult to maintain as your application grows. This framework eliminates that complexity:

**Without DI Framework:**

```typescript
const createServerContext = (env, ctx) => {
  if (!instanceState.member) {
    const contextInstance = Context.create({
      contactService: ContactService.create({}),
      assetService: AssetService.create({}),
      transactionService: TransactionService.create({}),
      // ... 20+ more services manually created and wired
    });
    instanceState.member = contextInstance;
  }

  instanceState.member.setEnv(env);
  instanceState.member.setCtx(ctx);
  // ... manual dependency wiring
  return instanceState.member;
};
```

**With DI Framework:**

```typescript
@Container()
export class ApplicationContext {
  constructor(
    @Component(ContactService) private contactService: ContactService,
    @Component(AssetService) private assetService: AssetService,
    @Component(TransactionService)
    private transactionService: TransactionService,
    // ... all services automatically injected
  ) {}
}

// Usage
const container = useContainer();
const appContext = container.resolve(ApplicationContext);
```

**Benefits:**

- No manual service instantiation
- No manual dependency wiring
- Automatic singleton management
- Type-safe dependency resolution
- Easier to test (mock services simply by registering test implementations)
- Scales better as services grow

## Quick Example

```typescript
import { Container, Component } from '@di-framework/core/decorators';
import { useContainer } from '@di-framework/core/container';

// Define a service
@Container()
export class DatabaseService {
  connect(): void {
    console.log('Connected to database');
  }
}

// Use it in another service
@Container()
export class UserService {
  @Component(DatabaseService)
  private db!: DatabaseService;

  getUser(id: string) {
    return this.db.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}

// Resolve and use
const container = useContainer();
const userService = container.resolve<UserService>(UserService);
userService.getUser('123');
```

## Next Steps

- [Installation](installation.md) - Set up the framework in your project
- [Quick Start](quick-start.md) - Learn the basics with simple examples
- [CLI](cli.md) - App `init` / `check` / `build` and maintainer `mx`
- [Runtime type checks](tsc.md) - Emit-time parameter guards (`@di-framework/tsc`; wired by `init`)
- [HTTP Router](http-router.md) - Type-safe routes and OpenAPI generation
- [GraphQL](graphql.md) - Domain classes as a GraphQL schema
- [Events](events.md) - Bridge container events to Kafka / NATS / memory
- [Sockets](socket.md) - WebSocket, TCP, UDP with a secure channel (`@di-framework/socket`)
- [RPC](rpc.md) - JSON-RPC and per-method gRPC with a typed client (`@di-framework/rpc`)
- [Configuration](config.md) - Typed config from env/files via DI
- [Authentication](auth.md) - Sessions, JWT, OAuth2/OIDC, and passkeys
- [Resource Authorization](authorization.md) - Declarative policies and HTTP resource enforcement
- [AI](ai.md) - Chat, tools, RAG, MCP, and agents with `@di-framework/ai`
- [Repositories](repositories.md) - Standardized data access with `@di-framework/repo`
- [API Reference](api-reference.md) - Complete API documentation
- [Advanced Usage](advanced-usage.md) - Learn advanced patterns and techniques
