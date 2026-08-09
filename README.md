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

| Package | Latest version | Description | Size | Weekly downloads |
| --- | --- | --- | --- | --- |
| `@di-framework/core` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcore?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/core) | DI container and decorators | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcore?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/core) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcore?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/core) |
| `@di-framework/cli` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcli?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/cli) | App CLI: `init`, `build`, `check` | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcli?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcli?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli) |
| `@di-framework/codegen` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcodegen?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/codegen) | Code generation engine for `@di-framework` schema manifests | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcodegen?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/codegen) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcodegen?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/codegen) |
| `@di-framework/tsc` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Ftsc?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/tsc) | `ttsc` runtime parameter checks (wired by `init`) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Ftsc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/tsc) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Ftsc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/tsc) |
| `@di-framework/repo` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Frepo?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/repo) | Data access / repositories | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Frepo?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/repo) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Frepo?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/repo) |
| `@di-framework/http` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fhttp?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/http) | HTTP routing and OpenAPI | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fhttp?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/http) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fhttp?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/http) |
| `@di-framework/graphql` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fgraphql?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/graphql) | GraphQL schema from domain objects | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fgraphql?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/graphql) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fgraphql?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/graphql) |
| `@di-framework/events` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fevents?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/events) | Bridge container events to Kafka / NATS / memory | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fevents?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/events) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fevents?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/events) |
| `@di-framework/config` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fconfig?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/config) | Typed config from env/files via DI | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fconfig?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/config) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fconfig?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/config) |
| `@di-framework/auth` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fauth?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/auth) | Sessions, JWT, OAuth2/OIDC, WebAuthn | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fauth?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/auth) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fauth?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/auth) |
| `@di-framework/authz` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fauthz?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/authz) | Declarative resource policies | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fauthz?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/authz) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fauthz?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/authz) |
| `@di-framework/socket` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fsocket?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/socket) | WebSocket / TCP / UDP (WebCrypto channel) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fsocket?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/socket) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fsocket?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/socket) |
| `@di-framework/rpc` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Frpc?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/rpc) | JSON-RPC and per-method gRPC / Connect | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Frpc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/rpc) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Frpc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/rpc) |
| `@di-framework/ai` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fai?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/ai) | Chat, tools, RAG, MCP, agents | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fai?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai) | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fai?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai) |

See [Examples](examples/).

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
