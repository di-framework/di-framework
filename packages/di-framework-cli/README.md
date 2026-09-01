# @di-framework/cli

CLI for apps built with `@di-framework/*`. Monorepo maintainer actions live under **`mx`**.

The complete hierarchy, output format, error behavior, exit statuses, and package ownership boundaries are
defined by the [unified CLI command contract](../../docs/cli-command-contract.md). That hierarchy is
exhaustive: public aliases, legacy routes, and package-specific CLIs are not supported.

Requires [Bun](https://bun.sh). The package ships TypeScript source as the `bin` entry — no platform-specific compiled binary.

## Install

```bash
bun add -d @di-framework/cli
# or one-shot:
bun x @di-framework/cli <command>
```

From this monorepo:

```bash
cd packages/di-framework-cli && bun link
di-framework <command> [args...]
```

## App commands

| Command | Description |
| ------- | ----------- |
| **`init [name]`** | Scaffold a new app (`package.json`, `tsconfig` with `@di-framework/tsc`, sample `src/index.ts`) |
| **`build`** | Emit with `ttsc --emit` when available, otherwise `tsc -p tsconfig.json` |
| **`check`** | Typecheck with `ttsc --noEmit` when available, otherwise `tsc --noEmit` |

```bash
di-framework init my-api
cd my-api && bun install && bun run dev

di-framework check
di-framework build
```

`init` wires `@di-framework/tsc` and `@di-framework/cli` by default (`plugins` in `tsconfig`; `"build"` / `"check"` scripts call `di-framework`; `ttsc` and TypeScript 7+ come with `@di-framework/tsc`). Runtime parameter checks are injected on `ttsc --emit` (`bun run build` / `bun start`). `bun run dev` executes source with Bun and skips emit-time checks. The first `ttsc` build needs a Go toolchain.
### `init` options

```
di-framework init [name] [--dir path] [--name pkg-name] [--force]
```

## Maintainer commands (`mx`)

Used only inside the **di-framework monorepo** (publish, package graph build, E2E):

```bash
di-framework mx build                     # compile packages
di-framework mx build --sync-versions     # also align package.json versions (release)
di-framework mx test        # monorepo E2E suite
di-framework mx typecheck   # language-service typecheck
di-framework mx publish     # test → build → npm publish
```

## Adding commands

- Add terminal routing and presentation under this package.
- Put domain behavior and typed results in the owning feature package; command handlers only translate
  arguments and presentation.
- Never add another executable or compatibility alias.
