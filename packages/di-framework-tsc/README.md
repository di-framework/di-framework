# @di-framework/tsc

[`ttsc`](https://ttsc.dev) transform plugin that injects **runtime parameter checks** from your TypeScript types.

Source stays plain TypeScript — no `assert()`, schemas, or decorators. On emit, function bodies get `typeof`, equality, and shape guards synthesized from parameter types.

Function declarations and expressions, arrows (including concise and async arrows), methods, and constructors are supported.

`di-framework init` wires this by default. Use the steps below for an existing app.

## Install

```bash
npm i -D @di-framework/tsc
```

Pulls in `ttsc` and TypeScript 7+ transitively.

First build compiles the Go sidecar (cached afterward). Needs a Go toolchain (`go` 1.26+ recommended; `ttsc` can pin via `TTSC_GO_BINARY`).

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

```ts
interface User {
  id: number;
  name: string;
}

function greet(user: User): string {
  return `hello ${user.name}`;
}
```

Emitted JS (simplified):

```js
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
2. This plugin walks functions, arrows, methods, and constructors.
3. For each required parameter, it reads the type (syntax keywords, else checker).
4. It synthesizes `if` / `throw` AST nodes with typescript-go `NodeFactory` and prepends them to the body.
5. `EmitAllRaw` prints JavaScript from the mutated AST.

## Limitations

Skipped today:

- destructured parameters
- variadic tuples, classes, branded types, typia-style tags
- unions with unsupported members or more than 12 members
- `void`, `never`, and `unique symbol`

Arrays and `ReadonlyArray<T>` are checked with `Array.isArray` and a full element scan.
Fixed tuples enforce their allowed length and validate each position; optional tails are presence-gated.
Optional and defaulted parameters are validated only when their runtime value is not `undefined`; `null` is still checked against the declared type.
Rest parameters use the same full array and element validation as ordinary arrays.

## Monorepo

Workspace package at `packages/di-framework-tsc`. It is listed in the CLI build/publish allowlists; `build` is a no-op (plugin.cjs + Go sidecar, not the TS5 `tsc` graph). `ttsc` and TypeScript 7+ are dependencies of this package (kept out of root / other `@di-framework/*` packages).

Isolated smoke fixture (pulls ttsc + TS7 via `@di-framework/tsc`):

```bash
cd packages/di-framework-tsc/fixture
bun install
bun run smoke          # ttsc --emit + check injected guards
# or: bun run smoke:dtsc
```

## Publish (maintainers)

```bash
cd packages/di-framework-tsc
bun run pack:check      # npm pack --dry-run
npm login               # once; scoped package needs org access
npm publish             # publishConfig.access=public
```

Smoke-test a packed tarball in another project:

```bash
npm pack
cd /path/to/other-project
npm i -D /path/to/di-framework-tsc-0.1.0.tgz
# add plugins: [{ "transform": "@di-framework/tsc" }]
npx ttsc --emit
```

## License

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
