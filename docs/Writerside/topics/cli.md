# CLI

`@di-framework/cli` is app-first: scaffold, typecheck, and build applications built with `@di-framework/*`. Monorepo maintainer workflows live under **`mx`**.

Requires [Bun](https://bun.sh). The package ships TypeScript source as the `bin` entry — no platform-specific compiled binary.

## Installation

```bash
bun add -d @di-framework/cli
# or one-shot:
bun x @di-framework/cli <command>
```

From a linked checkout of this monorepo:

```bash
cd packages/di-framework-cli && bun link
di-framework <command> [args...]
```

## App commands

| Command | Description |
| --- | --- |
| **`init [name]`** | Scaffold a new app (`package.json`, `tsconfig` with `@di-framework/tsc`, sample `src/index.ts`) |
| **`build`** | Emit with `ttsc --emit` when available, otherwise `tsc -p tsconfig.json` |
| **`check`** | Typecheck with `ttsc --noEmit` when available, otherwise `tsc --noEmit` |

```bash
di-framework init my-api
cd my-api && bun install && bun run dev

di-framework check
di-framework build
```

`init` installs `@di-framework/tsc` and `@di-framework/cli` by default, sets `plugins: [{ "transform": "@di-framework/tsc" }]`, and wires `"build"` / `"check"` to `di-framework` (`ttsc` and TypeScript 7+ come with `@di-framework/tsc`). Runtime checks are injected on `ttsc --emit` (`build` / `start`). `dev` runs source with Bun (no emit). First `ttsc` build needs a Go toolchain — see [Runtime type checks](tsc.md).

### `init` options

```
di-framework init [name] [--dir path] [--name pkg-name] [--force]
```

| Flag | Description |
| --- | --- |
| `--dir`, `-d` | Target directory (default: `./<name>`) |
| `--name`, `-n` | `package.json` name |
| `--force`, `-f` | Overwrite existing files |
| `--help`, `-h` | Show help |

Existing files are skipped unless `--force` is set.

## Maintainer commands (`mx`)

Used only inside the **di-framework monorepo** (package graph build, E2E, publish):

```bash
di-framework mx build                     # compile packages
di-framework mx build --sync-versions     # also align package.json versions (release)
di-framework mx test        # monorepo E2E suite
di-framework mx typecheck   # language-service typecheck
di-framework mx publish     # test → build → npm publish
```

Legacy top-level `test` / `typecheck` / `publish` still redirect to `mx` with a note so old scripts keep working.

## Next Steps

- [Installation](installation.md) - Core package setup
- [Quick Start](quick-start.md) - Basics after scaffolding
- [Runtime type checks](tsc.md) - `ttsc` transform (`@di-framework/tsc`; wired by `init`)
