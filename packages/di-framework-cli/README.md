# @di-framework/cli

CLI for apps built with `@di-framework/*`. Monorepo maintainer actions live under **`mx`**.

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
di-framework mx build       # build packages + sync versions
di-framework mx test        # monorepo E2E suite
di-framework mx typecheck   # language-service typecheck
di-framework mx publish     # test → build → npm publish
```

Legacy top-level `test` / `typecheck` / `publish` still redirect to `mx` with a note.

## Adding commands

- App-facing: add a module under `cmd/` and register it in `main.ts`.
- Maintainer: add under `cmd/mx/` and register in `cmd/mx.ts`.
