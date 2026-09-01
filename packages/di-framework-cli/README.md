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
| **`http openapi generate`** | Generate and write OpenAPI 3.1 from explicit controller modules |
| **`skills index build`** | Build a semantic Agent Skills index |
| **`skills index inspect`** | Inspect safe index metadata and sizes |
| **`skills index validate`** | Validate integrity and optional source drift |
| **`skills index query`** | Query an index and report selected matches or abstention |
| **`skills index migrate`** | Rewrite an index in the current format |
| **`skills validate`** | Validate neutral default and explicit Agent Skills catalogs |

```bash
di-framework init my-api
cd my-api && bun install && bun run dev

di-framework check
di-framework build
```

### HTTP OpenAPI generation

```bash
di-framework http openapi generate \
  --controllers ./src/controllers.ts \
  --controllers ./src/admin/controllers.ts \
  --output ./openapi.json
```

`--controllers` is required and repeatable. `--output` defaults to
`openapi.json`. The command delegates controller loading, document generation,
and file writing to the typed `@di-framework/http` APIs. Add global `--json`
anywhere in the invocation to receive the shared single-value envelope with
`controllerModules`, `outputPath`, and `bytes`; failures use stable command
codes and exit status `2` for usage or `3` for loading/writing failures.

### Skills index operations

```bash
di-framework skills index build \
  --skills-dir ./.agents/skills \
  --output ./.di-framework/skills-index.json
di-framework skills index inspect --input ./.di-framework/skills-index.json
di-framework skills index validate \
  --input ./.di-framework/skills-index.json \
  --skills-dir ./.agents/skills
di-framework skills index query \
  --input ./.di-framework/skills-index.json \
  --query 'review TypeScript authorization'
di-framework skills index migrate \
  --input ./legacy-skills-index.json \
  --output ./.di-framework/skills-index.json
```

These leaves map their arguments directly to the typed
`@di-framework/ai-utils` skills-index operations. Add global `--json` anywhere
in an invocation for the shared one-value JSON envelope; its `data` is the
package result. Text mode summarizes the same fields. Validation drift and
query abstention exit `1`; invalid options, missing sources/indexes, and invalid
indexes exit `2`; embedding, writing, dependency, and unexpected operation
failures exit `3`.

### Skills validation

```bash
# Validate <workspace>/.agents/skills and ~/.agents/skills.
di-framework skills validate

# Add explicit directory and package sources before the neutral defaults.
di-framework skills validate \
  --workspace . \
  --skills-dir ./team-skills \
  --skills-package @example/shared-skills

# Validate only explicitly configured sources.
di-framework skills validate \
  --skills-dir ./team-skills \
  --source-mode replace \
  --json
```

The command delegates resolution and every validation decision to
`validateSkillCatalog` from `@di-framework/ai-utils`. Text output prints a
summary followed by source-aware diagnostics. JSON output uses the shared
envelope and includes `valid`, `skillCount`, and the package's typed
`diagnostics`; skill bodies are not emitted. A valid catalog exits `0`,
catalogs with error findings exit `1`, malformed CLI configuration exits `2`, and a
missing package or unexpected execution failure exits `3`.

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
- Define nested command nodes with the shared `command.ts` dispatcher. Handlers receive command-local
  arguments and injectable output streams, return structured data, and use `CommandFailure` for stable
  failures; only the executable boundary assigns `process.exitCode`.
- Put domain behavior and typed results in the owning feature package; command handlers only translate
  arguments and presentation.
- Never add another executable or compatibility alias.
