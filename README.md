# di-framework

Lightweight, type-safe dependency injection for TypeScript — plus packages for HTTP, GraphQL, events, auth, RPC, and more.

[Documentation](https://docs.di-framework.dev)

## Get started

```bash
bun x @di-framework/cli init my-api
cd my-api && bun install && bun run dev
```

Or install the core package into an existing project:

```bash
bun add @di-framework/core
```

```ts
import { Container, Publisher, Subscriber } from '@di-framework/core/decorators';

@Container()
class UserService {
  @Publisher('user.created')
  createUser(name: string) {
    return { id: 1, name };
  }
}

@Container()
class AuditService {
  @Subscriber('user.created')
  onUserCreated(event: any) {
    console.log('User created:', event.result);
  }
}
```

## Packages

| Package | Description |
| --- | --- |
| [`@di-framework/core`](packages/di-framework-core) | DI container and decorators |
| [`@di-framework/cli`](packages/di-framework-cli) | App CLI: `init`, `build`, `check` |
| [`@di-framework/tsc`](packages/di-framework-tsc) | `ttsc` runtime parameter checks (wired by `init`) |
| [`@di-framework/repo`](packages/di-framework-repo) | Data access / repositories |
| [`@di-framework/http`](packages/di-framework-http) | HTTP routing and OpenAPI |
| [`@di-framework/graphql`](packages/di-framework-graphql) | GraphQL schema from domain objects |
| [`@di-framework/events`](packages/di-framework-events) | Bridge container events to Kafka / NATS / memory |
| [`@di-framework/config`](packages/di-framework-config) | Typed config from env/files via DI |
| [`@di-framework/auth`](packages/di-framework-auth) | Sessions, JWT, OAuth2/OIDC, WebAuthn |
| [`@di-framework/authz`](packages/di-framework-authz) | Declarative resource policies |
| [`@di-framework/socket`](packages/di-framework-socket) | WebSocket / TCP / UDP (WebCrypto channel) |
| [`@di-framework/rpc`](packages/di-framework-rpc) | JSON-RPC and per-method gRPC / Connect |
| [`@di-framework/ai`](packages/di-framework-ai) | Chat, tools, RAG, MCP, agents |

Examples live under [`examples/`](examples).

## CLI

```bash
bun x @di-framework/cli <command>
```

**Apps**

| Command | Description |
| --- | --- |
| `init` | Scaffold a new application (`@di-framework/tsc` + `ttsc` by default) |
| `check` | Typecheck with `ttsc --noEmit` or `tsc --noEmit` |
| `build` | Emit with `ttsc --emit` or `tsc` |

**Maintainers** (this monorepo)

| Command | Description |
| --- | --- |
| `mx build` | Build packages and sync versions |
| `mx test` | Run the monorepo E2E suite |
| `mx typecheck` | Typecheck the workspace |
| `mx publish` | Test, build, and publish to npm |

```bash
di-framework init my-api
di-framework check
di-framework mx build   # maintainers only
```

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
