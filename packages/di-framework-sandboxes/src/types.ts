export interface ControlClientOptions {
  /** Control-service base URL. Defaults to `http://127.0.0.1:8787`. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface SandboxCreateOptions extends ControlClientOptions {
  /** Human-readable guest name. Defaults to a generated id. */
  name?: string;
  /**
   * Guest RAM in MiB. Must be a power of two between 16 and 512.
   * @default 64
   */
  memoryMiB?: number;
  /**
   * Guest runtime image (`shell`, `python`, `node`, `go`, …).
   * Built into `assets/runtimes/<runtime>/` via `./scripts/build-guest-runtime.sh`.
   * @default "shell"
   */
  runtime?: SandboxRuntime;
  /**
   * How long to wait for the guest shell after the emulator reports running.
   * @default 120_000
   */
  readyTimeoutMs?: number;
  /** Override the low-level control client. Useful for tests. */
  client?: import('./client.ts').ControlClient;
}

/** Built-in BusyBox guest profiles (see `docker/busybox/Dockerfile*`). */
export type SandboxRuntime = 'shell' | 'python' | 'node' | 'go' | 'buildroot' | (string & {});

export interface CommandOptions extends WaitOptions {
  /**
   * Working directory inside the guest.
   * Applied with `cd` before the command.
   */
  cwd?: string;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WriteFileOptions {
  /** File mode bits as an octal string, e.g. `"0644"`. */
  mode?: string;
}
