import { ControlClient, type Instance } from './client.ts';
import { SandboxCommandError, SandboxTimeoutError } from './errors.ts';
import {
  buildCommandScript,
  looksLikeShellReady,
  makeMarker,
  parseCommandOutput,
  sanitizeSerial,
  shellQuote,
} from './serial.ts';
import { sleep } from './sleep.ts';
import type {
  CommandOptions,
  CommandResult,
  SandboxCreateOptions,
  WriteFileOptions,
} from './types.ts';

/**
 * Isolated Linux guest for running untrusted shell commands and scripts.
 *
 * Talks to a di-framework sandbox control service (v86 guest per isolate).
 * Guests share no host filesystem or network adapter; treat this as
 * process-local isolation and still apply OS-level limits for hostile tenants.
 */
export class Sandbox {
  readonly id: string;
  readonly name: string;
  readonly memoryMiB: number;
  readonly runtime: string;

  #client: ControlClient;
  #cursor = 0;
  #closed = false;
  #ready = false;

  private constructor(client: ControlClient, instance: Instance) {
    this.#client = client;
    this.id = instance.id;
    this.name = instance.name;
    this.memoryMiB = instance.memory_mib;
    this.runtime = instance.runtime ?? 'shell';
  }

  /** Create, boot, and wait until the guest shell is ready. */
  static async create(options: SandboxCreateOptions = {}): Promise<Sandbox> {
    const client =
      options.client ??
      new ControlClient({
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });

    const memoryMiB = options.memoryMiB ?? 64;
    const runtime = options.runtime ?? 'shell';
    const name = options.name ?? `sandbox-${crypto.randomUUID().slice(0, 8)}`;

    const instance = await client.create({
      name,
      memory_mib: memoryMiB,
      runtime,
      autostart: true,
    });

    const sandbox = new Sandbox(client, instance);
    try {
      await client.waitForStatus(instance.id, 'running', {
        timeoutMs: options.readyTimeoutMs ?? 120_000,
      });
      await sandbox.#waitForShell({
        timeoutMs: options.readyTimeoutMs ?? 120_000,
      });
      return sandbox;
    } catch (error) {
      await sandbox.close().catch(() => undefined);
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Run a shell command and capture stdout / exit code. */
  async run(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    this.#assertOpen();
    await this.#ensureReady(options);

    const marker = makeMarker();
    const script = buildCommandScript(command, marker, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    const baseline = await this.#drain();
    await this.#client.sendSerial(this.id, script);

    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let buffered = baseline;

    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      buffered += sanitizeSerial((await this.#readMore()).data);
      const parsed = parseCommandOutput(buffered, marker);
      if (parsed) {
        return {
          stdout: parsed.stdout,
          stderr: '',
          exitCode: parsed.exitCode,
        };
      }
      await sleep(pollIntervalMs, options.signal);
    }

    throw new SandboxTimeoutError(`timed out after ${timeoutMs}ms waiting for command to finish`);
  }

  /**
   * Like {@link run}, but throws {@link SandboxCommandError} when exit code ≠ 0.
   */
  async runChecked(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const result = await this.run(command, options);
    if (result.exitCode !== 0) {
      throw new SandboxCommandError(`command exited with code ${result.exitCode}`, result);
    }
    return result;
  }

  /** Write a UTF-8 text file into the guest via a here-document. */
  async writeFile(path: string, contents: string, options: WriteFileOptions = {}): Promise<void> {
    const delimiter = `DFEOF_${makeMarker('eof')}`;
    if (contents.includes(delimiter)) {
      throw new Error('file contents collide with generated heredoc delimiter');
    }

    const mode = options.mode ?? '0644';
    const script = [
      `cat > ${shellQuote(path)} <<'${delimiter}'`,
      contents.endsWith('\n') ? contents.slice(0, -1) : contents,
      delimiter,
      `chmod ${shellQuote(mode)} ${shellQuote(path)}`,
    ].join('\n');

    await this.runChecked(script);
  }

  /** Read a UTF-8 text file from the guest. */
  async readFile(path: string, options: CommandOptions = {}): Promise<string> {
    const result = await this.runChecked(`cat ${shellQuote(path)}`, options);
    return result.stdout;
  }

  /** Execute a script body with the runtime's default interpreter (or `options.interpreter`). */
  async exec(
    script: string,
    options: CommandOptions & { interpreter?: string } = {},
  ): Promise<CommandResult> {
    const interpreter = options.interpreter ?? defaultInterpreter(this.runtime);
    const remotePath = `/tmp/df-exec-${makeMarker()}${scriptExtension(interpreter)}`;
    await this.writeFile(remotePath, script.endsWith('\n') ? script : `${script}\n`, {
      mode: '0755',
    });
    try {
      return await this.run(`${shellQuote(interpreter)} ${shellQuote(remotePath)}`, options);
    } finally {
      await this.run(`rm -f ${shellQuote(remotePath)}`).catch(() => undefined);
    }
  }

  /** Incrementally stream raw serial output. */
  async *serial(
    options: CommandOptions & { cursor?: number } = {},
  ): AsyncGenerator<string, never, void> {
    this.#assertOpen();
    let cursor = options.cursor ?? this.#cursor;
    const pollIntervalMs = options.pollIntervalMs ?? 50;

    while (true) {
      options.signal?.throwIfAborted();
      const output = await this.#client.readSerial(this.id, cursor);
      cursor = output.cursor;
      this.#cursor = cursor;
      if (output.data) yield sanitizeSerial(output.data);
      await sleep(pollIntervalMs, options.signal);
    }
  }

  /** Stop and destroy the guest. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#client.stop(this.id).catch(() => undefined);
    } finally {
      await this.#client.delete(this.id).catch(() => undefined);
    }
  }

  /** `await using` support. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`sandbox ${this.id} is closed`);
    }
  }

  async #ensureReady(options: CommandOptions): Promise<void> {
    if (this.#ready) return;
    await this.#waitForShell({
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async #waitForShell(options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let buffered = '';

    // Nudge the shell in case it is waiting on an idle prompt.
    await this.#client.sendSerial(this.id, '\n').catch(() => undefined);

    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      buffered += sanitizeSerial((await this.#readMore()).data);
      if (looksLikeShellReady(buffered)) {
        this.#ready = true;
        return;
      }
      await sleep(pollIntervalMs, options.signal);
    }

    throw new SandboxTimeoutError(`timed out after ${timeoutMs}ms waiting for guest shell`);
  }

  async #drain(): Promise<string> {
    const output = await this.#readMore();
    return sanitizeSerial(output.data);
  }

  async #readMore() {
    const output = await this.#client.readSerial(this.id, this.#cursor);
    this.#cursor = output.cursor;
    return output;
  }
}

function defaultInterpreter(runtime: string): string {
  switch (runtime) {
    case 'python':
      return 'python3';
    case 'node':
      return 'node';
    case 'go':
      return 'yaegi';
    default:
      return '/bin/sh';
  }
}

function scriptExtension(interpreter: string): string {
  if (interpreter.includes('python')) return '.py';
  if (interpreter.includes('node') || interpreter.includes('qjs')) return '.js';
  if (interpreter.includes('yaegi') || interpreter.endsWith('go')) return '.go';
  return '.sh';
}
