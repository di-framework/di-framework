# `@di-framework/sandboxes`

Run untrusted code inside isolated Linux guests (BusyBox + v86).

Each sandbox maps to a dedicated guest on a sandbox **control service** (Rust +
v86). Guests boot a Debian i386 **bzImage** with a BusyBox **initrd**. Profiles
package language interpreters into the initrd:

| `runtime` | Interpreter in guest |
| --- | --- |
| `shell` (default) | BusyBox `/bin/sh` |
| `python` | MicroPython as `python3` |
| `node` | QuickJS as `node` |
| `go` | Yaegi |

The control service, guest Dockerfiles, and asset build scripts live in the
[`di-framework-sandboxes`](https://github.com/di-framework/di-framework-sandboxes)
repository.

> Process-local isolation is not a hardened multi-tenant boundary. For hostile
> workloads, run one control process per security domain under OS memory/CPU
> limits, namespaces, and seccomp.

## Install

```bash
bun add @di-framework/sandboxes
# or
npm install @di-framework/sandboxes
```

Start a control service (from `di-framework-sandboxes`), then:

```ts
import { Sandbox } from '@di-framework/sandboxes';

await using sandbox = await Sandbox.create({
  baseUrl: 'http://127.0.0.1:8787',
  runtime: 'python',
  memoryMiB: 64,
});

console.log((await sandbox.exec('print(2 + 2)')).stdout);
```

## API

### `Sandbox.create(options?)`

Boots a guest and waits until a shell prompt is ready.

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | Control service URL |
| `runtime` | `shell` | `shell` \| `python` \| `node` \| `go` |
| `memoryMiB` | `64` | Power of two, 16–512 |
| `name` | generated | Guest label |
| `readyTimeoutMs` | `120000` | Boot + shell wait |

### `sandbox.run(command, options?)`

Executes a shell command and returns `{ stdout, stderr, exitCode }`.

Serial consoles merge stdout/stderr; `stderr` is currently always `""`.

### `sandbox.exec(script, options?)`

Writes a temp script and runs it with the runtime default interpreter
(`python3` / `node` / `yaegi` / `/bin/sh`), or `options.interpreter`.

### `sandbox.writeFile` / `sandbox.readFile` / `sandbox.close`

UTF-8 file transfer and teardown. `Sandbox` implements `Symbol.asyncDispose`.

### `ControlClient`

Low-level typed HTTP client for instance lifecycle and serial I/O.

## Development

```bash
cd packages/di-framework-sandboxes
bun test
bun run build
bun run pack:check
```

## License

MIT OR Apache-2.0
