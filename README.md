# @di-framework/core

[Documentation](https://docs.di-framework.dev)

```
npm i @di-framework/core
```

- `packages/di-framework-core` - core container
- `packages/di-framework-repo` - data access
- `packages/di-framework-http` - http handling
- `packages/di-framework-graphql` - GraphQL schema from domain objects
- `packages/di-framework-events` - bridge container events to Kafka / NATS / memory
- `packages/di-framework-config` - typed config from env/files, validated and injected via DI
- `packages/di-framework-auth` - authentication: sessions, JWT, OAuth2/OIDC, WebAuthn (WebCrypto, zero deps)
- `packages/di-framework-authz` - declarative resource policies, EBNF interchange, and HTTP controller authorization
- `packages/di-framework-socket` - security-first WebSocket / TCP / UDP (WebCrypto secure channel)
- `packages/di-framework-rpc` - decorator-generated JSON-RPC and per-method gRPC / Connect
- `packages/di-framework-ai` - Spring AI–aligned chat, tools, RAG, MCP, and agents
- `packages/di-framework-cli` - app CLI (`init`, `build`, `check`) + maintainer `mx`
- `packages/di-framework-tsc` - optional `ttsc` transform for runtime parameter checks
- `examples` - usage examples

## CLI

`bun x @di-framework/cli`

```
di-framework <command>
```

| Command   | Description |
| --------- | ----------- |
| `init`    | Scaffold a new di-framework application |
| `build`   | Build the current app (`package.json` script or `tsc`) |
| `check`   | Typecheck the current app |
| `mx …`    | Maintainer tools for this monorepo (`build`, `test`, `typecheck`, `publish`) |

```bash
di-framework init my-api
di-framework check
di-framework mx build    # monorepo maintainers
```

## Simple Example

```ts
import { Container, Publisher, Subscriber } from '@di-framework/core';

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
