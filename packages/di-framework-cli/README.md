# @di-framework/cli

Monorepo tooling for `@di-framework` (`build`, `test`, `typecheck`, `publish`).

Requires [Bun](https://bun.sh). The package ships TypeScript source as the `bin` entry — no platform-specific compiled binary.

## Usage

### Link (from the monorepo)

```bash
cd packages/di-framework-cli
bun link
```

```bash
di-framework <command> [args...]
```

### Run without linking

```bash
bun run packages/di-framework-cli/main.ts <command> [args...]
```

### Available commands

- **`build`** — build packages and sync versions
- **`test`** — E2E test suite
- **`typecheck`** — TypeScript project checks
- **`publish`** — publish packages to npm

## Adding commands

Add a module under `cmd/` and register it in `main.ts`.
