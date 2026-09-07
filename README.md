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

| Package | Latest version | Description | Size | Coverage | Weekly downloads |
| --- | --- | --- | --- | --- | --- |
| `@di-framework/core` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcore?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/core) | DI container and decorators | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcore?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/core) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcore.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcore?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/core) |
| `@di-framework/cli` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcli?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/cli) | App CLI: `init`, `build`, `check` | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcli?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcli.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcli?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli) |
| `@di-framework/codegen` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcodegen?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/codegen) | Code generation engine for `@di-framework` schema manifests | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcodegen?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/codegen) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcodegen.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcodegen?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/codegen) |
| `@di-framework/tsc` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Ftsc?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/tsc) | `ttsc` runtime parameter checks (wired by `init`) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Ftsc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/tsc) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Ftsc.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Ftsc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/tsc) |
| `@di-framework/repo` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Frepo?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/repo) | Data access / repositories | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Frepo?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/repo) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Frepo.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Frepo?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/repo) |
| `@di-framework/http` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fhttp?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/http) | HTTP routing and OpenAPI | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fhttp?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/http) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fhttp.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fhttp?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/http) |
| `@di-framework/graphql` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fgraphql?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/graphql) | GraphQL schema from domain objects | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fgraphql?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/graphql) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fgraphql.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fgraphql?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/graphql) |
| `@di-framework/events` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fevents?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/events) | Bridge container events to Kafka / NATS / memory | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fevents?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/events) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fevents.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fevents?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/events) |
| `@di-framework/config` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fconfig?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/config) | Typed config from env, JSON, YAML, and TOML via DI | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fconfig?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/config) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fconfig.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fconfig?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/config) |
| `@di-framework/auth` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fauth?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/auth) | Sessions, JWT, OAuth2/OIDC, WebAuthn | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fauth?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/auth) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fauth.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fauth?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/auth) |
| `@di-framework/authz` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fauthz?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/authz) | Declarative resource policies | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fauthz?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/authz) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fauthz.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fauthz?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/authz) |
| `@di-framework/socket` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fsocket?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/socket) | WebSocket / TCP / UDP (WebCrypto channel) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fsocket?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/socket) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fsocket.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fsocket?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/socket) |
| `@di-framework/rpc` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Frpc?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/rpc) | JSON-RPC and per-method gRPC / Connect | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Frpc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/rpc) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Frpc.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Frpc?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/rpc) |
| `@di-framework/ai` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fai?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/ai) | Chat, tools, RAG, MCP, agents | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fai?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fai.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fai?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai) |
| `@di-framework/ai-utils` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fai-utils?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/ai-utils) | Agent Skills (`SKILL.md`) toolbox (`SkillsAgent.builder`) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fai-utils?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai-utils) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fai-utils.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fai-utils?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/ai-utils) |
| `@di-framework/cli-extension` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcli-extension?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/cli-extension) | Author API for CLI extensions (`defineExtension`) | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcli-extension?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli-extension) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcli-extension.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcli-extension?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli-extension) |
| `@di-framework/cli-plugin-wasmcloud` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcli-plugin-wasmcloud?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/cli-plugin-wasmcloud) | CLI extension: build, serve, and deploy wasmCloud components | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcli-plugin-wasmcloud?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli-plugin-wasmcloud) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcli-plugin-wasmcloud.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcli-plugin-wasmcloud?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cli-plugin-wasmcloud) |
| `@di-framework/cloudfoundry` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fcloudfoundry?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/cloudfoundry) | Cloud Foundry VCAP discovery, application metadata, and DI binding | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fcloudfoundry?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cloudfoundry) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fcloudfoundry.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fcloudfoundry?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/cloudfoundry) |
| `@di-framework/wasmcloud` | [![latest npm version](https://img.shields.io/npm/v/%40di-framework%2Fwasmcloud?label=&logo=npm&color=white&logoColor=cb3837)](https://www.npmjs.com/package/@di-framework/wasmcloud) | Native wasmCloud WIT service bindings and DI | [![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40di-framework%2Fwasmcloud?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/wasmcloud) | [![line coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdocs.di-framework.dev%2Fcoverage%2Fwasmcloud.json)]() | [![npm weekly downloads](https://img.shields.io/npm/dw/%40di-framework%2Fwasmcloud?label=&logo=npm)](https://www.npmjs.com/package/@di-framework/wasmcloud) |

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
| `mx build` | Build packages (`--sync-versions` before publish) |
| `mx test` | Run the monorepo E2E suite |
| `mx typecheck` | Typecheck the workspace |
| `mx publish` | Test, build, and publish to npm |

**Extensions** (optional command groups)

| Command | Description |
| --- | --- |
| `extensions install <name>` | Install a CLI extension (e.g. `@di-framework/cli-plugin-<name>`) |
| `extensions uninstall <name>` | Remove an installed CLI extension |
| `extensions list` | List installed CLI extensions |

```bash
di-framework init my-api
di-framework check
di-framework mx build   # maintainers only
```

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
