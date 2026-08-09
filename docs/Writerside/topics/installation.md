# Installation

The core package has no runtime dependencies and works with SWC and TypeScript's decorator support.

## Requirements

- TypeScript 5.0 or higher
- SWC or TypeScript compiler with decorator support enabled

## Scaffold an app (recommended)

The fastest path is the app CLI:

```bash
bun x @di-framework/cli init my-api
cd my-api && bun install && bun run dev
```

That writes a `tsconfig.json` with `@di-framework/tsc` (`plugins`), `@di-framework/cli`, and sample `src/index.ts` (`ttsc` and TypeScript 7+ come with `@di-framework/tsc`). Scripts call `di-framework build` / `di-framework check` (which run `ttsc`). Runtime parameter checks are injected on emit (`bun run build`). See [CLI](cli.md) for `check` / `build` and [Runtime type checks](tsc.md).

## Install the Package

```bash
npm install @di-framework/core
```

or with yarn:

```bash
yarn add @di-framework/core
```

or with bun:

```bash
bun add @di-framework/core
```

## Configuration

### TypeScript Configuration

Ensure your `tsconfig.json` has the following settings:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": false,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

Apps from `di-framework init` also include `plugins: [{ "transform": "@di-framework/tsc" }]` and emit via `ttsc`. For manual setup of runtime parameter checks, see [Runtime type checks](tsc.md).
### SWC Configuration

If you're using SWC, ensure your `.swcrc` has decorator support enabled:

```json
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": false
    }
  }
}
```

## No Additional Dependencies

The decorators are fully integrated with SWC's native support - **no need for `reflect-metadata` or any other polyfill**. This keeps your bundle size small and your dependencies minimal.

## Import paths and container singleton

Always import from the scoped package `@di-framework/core/*` to ensure a single global container instance. Mixing different import IDs (e.g., `di-framework/*` or relative paths to sources) can load a second copy of the library and create a second global container instance.

Correct:

```typescript
import { useContainer } from '@di-framework/core/container';
import { Container, Component } from '@di-framework/core/decorators';
```

Avoid:

```typescript
import { useContainer } from 'di-framework/container'; // Wrong: unscoped id
import { Container } from '../../di-framework/decorators'; // Wrong: relative id
```

## Verify Installation

Create a simple test file to verify the installation:

```typescript
import { Container } from '@di-framework/core/decorators';
import { useContainer } from '@di-framework/core/container';

@Container()
class TestService {
  getMessage() {
    return 'di-framework is working!';
  }
}

const container = useContainer();
const service = container.resolve(TestService);
console.log(service.getMessage());
```

Run the file with your TypeScript runner (ts-node, tsx, bun, etc.):

```bash
bun run test.ts
# Output: di-framework is working!
```

## Optional Packages

The core package stands alone. Companion packages add data access, HTTP, GraphQL, events, sockets, RPC, configuration, authentication, and AI support:

| Package | Docs |
| --- | --- |
| `@di-framework/cli` | [CLI](cli.md) |
| `@di-framework/tsc` | [Runtime type checks](tsc.md) (default in `init`) |
| `@di-framework/repo` | [Repositories](repositories.md) |
| `@di-framework/http` | [HTTP Router](http-router.md) |
| `@di-framework/graphql` | [GraphQL](graphql.md) |
| `@di-framework/events` | [Events](events.md) |
| `@di-framework/socket` | [Sockets](socket.md) |
| `@di-framework/rpc` | [RPC](rpc.md) |
| `@di-framework/config` | [Configuration](config.md) |
| `@di-framework/auth` | [Authentication](auth.md) |
| `@di-framework/authz` | [Resource Authorization](authorization.md) |
| `@di-framework/ai` | [AI](ai.md) |

## Next Steps

Now that you have the framework installed, learn how to use it:

- [Quick Start](quick-start.md) - Learn the basics with simple examples
- [CLI](cli.md) - App `init` / `check` / `build` and maintainer `mx`
- [API Reference](api-reference.md) - Complete API documentation
