# Installation

No external dependencies required! The framework works with SWC and TypeScript's native decorator support.

## Requirements

- TypeScript 5.0 or higher
- SWC or TypeScript compiler with decorator support enabled

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

Ensure your `../../../tsconfig.json` has the following settings:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

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
      "decoratorMetadata": true
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
    return 'DI Framework is working!';
  }
}

const container = useContainer();
const service = container.resolve(TestService);
console.log(service.getMessage());
```

Run the file with your TypeScript runner (ts-node, tsx, bun, etc.):

```bash
bun run test.ts
# Output: DI Framework is working!
```

## Optional Packages

The core package stands alone. Companion packages add data access, HTTP, and GraphQL:

| Package | Docs |
| --- | --- |
| `@di-framework/repo` | [Repositories](repositories.md) |
| `@di-framework/http` | [HTTP Router](http-router.md) |
| `@di-framework/graphql` | [GraphQL](graphql.md) |

## Next Steps

Now that you have the framework installed, learn how to use it:

- [Quick Start](quick-start.md) - Learn the basics with simple examples
- [API Reference](api-reference.md) - Complete API documentation
