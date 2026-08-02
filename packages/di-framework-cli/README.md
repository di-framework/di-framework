# @di-framework/cli

This package contains the CLI tools and scripts used for managing the `@di-framework` monorepo.

## Usage

The CLI acts as a proxy to run various commands defined in the `cmd` directory.

### Global Installation (Recommended)

You can make the CLI available globally on your system as the `di-framework-core` command by linking it:

```bash
cd packages/bin
bun link
```

Then you can run commands from anywhere:

```bash
di-framework <command> [args...]
```

### Running Directly

Alternatively, you can run it directly using Bun from the root of the repository:

```bash
bun run packages/bin/main.ts <command> [args...]
```

### Available Commands

- **`build`**: Builds the packages in the monorepo (`di-framework-core`, `di-framework-repo`, `di-framework-http`). It cleans the `dist` directories and runs `tsc`.

  ```bash
  bun run packages/bin/main.ts build
  ```

- **`typecheck`**: Runs TypeScript type checking across the packages to ensure type safety without emitting compiled files.

  ```bash
  bun run packages/bin/main.ts typecheck
  ```

- **`publish`**: Publishes the built packages to the npm registry.
  ```bash
  bun run packages/bin/main.ts publish
  ```

## Adding New Commands

To add a new command, simply create a new TypeScript file in the `/cmd/` directory. The name of the file (without the `.ts` extension) will become the command name.
