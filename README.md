# @di-framework/core

[Documentation](https://docs.di-framework.dev)

```
npm i @di-framework/core
```

- `packages/di-framework-core` - core container
- `packages/di-framework-repo` - data access
- `packages/di-framework-http` - http handling
- `packages/di-framework-cli` - `di-framework-core` cli (build, test, typecheck, publish)
- `examples` - usage examples

## CLI

`bun x @di-framework/cli`

```
di-framework <command>
```

| Command     | Description                                                           |
| ----------- | --------------------------------------------------------------------- |
| `test`      | Runs the E2E test suite (type checks, unit tests, example validation) |
| `build`     | Builds all packages and syncs versions from the workspace root        |
| `typecheck` | Runs `tsc --noEmit` across all packages                               |
| `publish`   | Tests, builds, and publishes all packages to npm                      |

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
