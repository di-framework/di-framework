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
| **`init [name]`** | Scaffold a new app (`package.json`, decorator-ready `tsconfig`, sample `src/index.ts`) |
| **`build`** | Run the project’s `build` script, or `tsc -p tsconfig.json` if none |
| **`check`** | Typecheck with the nearest `tsconfig.json` (`tsc --noEmit`) |

```bash
di-framework init my-api
cd my-api && bun install && bun run dev

di-framework check
di-framework build
```

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
