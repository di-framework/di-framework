# Sandboxes (`@di-framework/sandboxes`)

Run untrusted code inside isolated Linux guests (BusyBox + v86).

Each sandbox is a dedicated guest on a **control service** (Rust + v86). Guests boot a Debian i386 **bzImage** with a BusyBox **initrd**. This package is the TypeScript client: create a guest, run commands, copy files, tear down.

It is **not** the path jail in [`@di-framework/ai-utils`](ai-utils.md). Skills `Bash` still `spawn`s on the host. Use this package when the command or script should not see the host filesystem or network.

The control service, guest Dockerfiles, and asset build scripts live in [`di-framework-sandboxes`](https://github.com/di-framework/di-framework-sandboxes).

Process-local isolation is not a hardened multi-tenant boundary. For hostile workloads, run one control process per security domain under OS memory/CPU limits, namespaces, and seccomp.

## Runtimes

| `runtime` | Interpreter in guest |
| --- | --- |
| `shell` (default) | BusyBox `/bin/sh` |
| `python` | MicroPython as `python3` |
| `node` | QuickJS as `node` |
| `go` | Yaegi |

## Installation

```bash
bun add @di-framework/sandboxes
```

```bash
npm install @di-framework/sandboxes
```

Start a control service from `di-framework-sandboxes`, then:

```typescript
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
| `client` | new `ControlClient` | Inject for tests |

`Sandbox` implements `Symbol.asyncDispose` (`await using`).

### `sandbox.run(command, options?)`

Executes a shell command and returns `{ stdout, stderr, exitCode }`.

Serial consoles merge stdout/stderr; `stderr` is currently always `""`. `runChecked` throws `SandboxCommandError` when `exitCode !== 0`. Options: `cwd`, `env`, `timeoutMs`, `pollIntervalMs`, `signal`.

### `sandbox.exec(script, options?)`

Writes a temp script and runs it with the runtime default interpreter (`python3` / `node` / `yaegi` / `/bin/sh`), or `options.interpreter`.

### `sandbox.writeFile` / `sandbox.readFile` / `sandbox.close`

UTF-8 file transfer and teardown. `close` is idempotent.

### `ControlClient`

Low-level typed HTTP client for instance lifecycle and serial I/O (`/health`, `/v1/instances`, serial read/write). Errors are `SandboxApiError`. Timeouts are `SandboxTimeoutError`.

## When to use it

- Untrusted skill scripts or model-generated code
- A shared agent service where host `Bash` is too much
- A reproducible guest (`python` / `node` / `go`) without Docker-in-Docker

Stay on host file tools and host `.shell()` when the agent should edit the real workspace.

## Related

- [Agent Skills](ai-utils.md) — `SKILL.md` toolbox; host `Bash` is opt-in and not a guest
- [Package README](https://github.com/di-framework/di-framework/blob/main/packages/di-framework-sandboxes/README.md)
- [Control service](https://github.com/di-framework/di-framework-sandboxes)
