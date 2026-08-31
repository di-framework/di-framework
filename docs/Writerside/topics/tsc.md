# Runtime type checks

`@di-framework/tsc` is a [`ttsc`](https://ttsc.dev) transform that injects **runtime parameter checks** from your TypeScript types.

Source stays plain TypeScript — no `assert()`, schemas, or decorators. On emit, function bodies get `typeof` / shape guards synthesized from parameter types.

Function declarations and expressions, arrows with block bodies, methods, and constructors are supported.

`di-framework init` wires this by default (`@di-framework/tsc` and `plugins` in `tsconfig`; `ttsc` and TypeScript 7+ come with `@di-framework/tsc`). Use the steps below for an existing app.

## Installation

```bash
npm i -D @di-framework/tsc
```

Pulls in `ttsc` and TypeScript 7+ transitively.

The first build compiles a Go sidecar (cached afterward). Needs a Go toolchain (`go` 1.26+ recommended; `ttsc` can pin via `TTSC_GO_BINARY`).

## Setup

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "plugins": [{ "transform": "@di-framework/tsc" }]
  }
}
```

The package also declares `ttsc.plugin` for auto-discovery when listed in `devDependencies`. Explicit `plugins[]` is recommended so wiring is obvious.

Build with `ttsc`, not stock `tsc`:

```bash
npx ttsc --emit
```

## Example

```typescript
interface User {
  id: number;
  name: string;
}

function greet(user: User): string {
  return `hello ${user.name}`;
}
```

Emitted JavaScript (simplified):

```javascript
function greet(user) {
  if (typeof user !== "object" || user === null)
    throw new TypeError("Expected user to be an object");
  if (typeof user.id !== "number")
    throw new TypeError("Expected user.id to be a number");
  if (typeof user.name !== "string")
    throw new TypeError("Expected user.name to be a string");
  return `hello ${user.name}`;
}
```

## How it works

1. `ttsc` loads the program (parse + typecheck).
2. The plugin walks functions, block-bodied arrows, methods, and constructors.
3. For each required parameter, it reads the type (syntax keywords, else checker).
4. It synthesizes `if` / `throw` AST nodes and prepends them to the body.
5. Emit prints JavaScript from the mutated AST.

## Limitations

Skipped today:

- concise expression-bodied arrows
- optional / default / rest / destructured parameters
- unions, arrays, tuples, classes, branded types, typia-style tags

## Monorepo note

`@di-framework/tsc` is isolated from the monorepo’s TypeScript 5.x `tsc` graph (package `build` is a no-op). `ttsc` and TypeScript 7+ are dependencies of `@di-framework/tsc` (kept out of root / other `@di-framework/*` packages).

## Next Steps

- [CLI](cli.md) - App `init` / `check` / `build` and maintainer `mx`
- [Installation](installation.md) - Core package setup
- [Best Practices](best-practices.md) - Recommended patterns
