import { describe, expect, test } from 'bun:test';
import type { ControlClient } from '../src/client.ts';
import { SandboxCommandError, SandboxTimeoutError } from '../src/errors.ts';
import { Sandbox } from '../src/sandbox.ts';

type SerialState = {
  cursor: number;
  buffer: string;
  pendingScripts: string[];
};

function createFakeControl(options?: {
  bootSerial?: string;
  onCommand?: (script: string, state: SerialState) => void;
}): ControlClient {
  const state: SerialState = {
    cursor: 0,
    buffer: options?.bootSerial ?? 'Buildroot boot\n# ',
    pendingScripts: [],
  };

  const id = '11111111-1111-1111-1111-111111111111';
  const instance = {
    id,
    name: 'test',
    status: 'running' as const,
    memory_mib: 64,
    runtime: 'shell',
    created_at: new Date().toISOString(),
    last_error: null,
  };

  const client = {
    async create() {
      return { ...instance, status: 'starting' as const };
    },
    async waitForStatus() {
      return instance;
    },
    async sendSerial(_id: string, data: string) {
      state.buffer += data;
      state.pendingScripts.push(data);
      options?.onCommand?.(data, state);

      const startMatch = data.match(/__DF_START_([A-Za-z0-9]+)__/);
      const marker = startMatch?.[1];
      if (marker) {
        // Simulate command output after the script echo.
        if (data.includes('echo hi') || data.includes('printf')) {
          // default handled below
        }
        if (data.includes('false') || /\bfalse\b/.test(data)) {
          state.buffer += `\n__DF_START_${marker}__\n\n__DF_END_${marker}:1__\n# `;
        } else if (data.includes('sleep-forever')) {
          // Intentionally never emit an end marker.
        } else if (data.includes('__DF_START_')) {
          const body = data.includes('uname')
            ? 'Linux guest'
            : data.includes("cat '/tmp/hello'")
              ? 'hello'
              : data.includes('echo hi')
                ? 'hi'
                : '';
          state.buffer += `\n__DF_START_${marker}__\n${body}\n__DF_END_${marker}:0__\n# `;
        }
      }

      if (data === '\n') {
        state.buffer += '# ';
      }
    },
    async readSerial(_id: string, cursor = 0) {
      const data = state.buffer.slice(cursor);
      return { data, cursor: state.buffer.length };
    },
    async stop() {
      return { ...instance, status: 'stopped' as const };
    },
    async delete() {
      return;
    },
  };

  return client as unknown as ControlClient;
}

describe('Sandbox', () => {
  test('create waits for shell and runs a command', async () => {
    const client = createFakeControl();
    await using sandbox = await Sandbox.create({ client });
    const result = await sandbox.run('echo hi');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
  });

  test('runChecked throws on non-zero exit', async () => {
    const client = createFakeControl();
    await using sandbox = await Sandbox.create({ client });
    await expect(sandbox.runChecked('false')).rejects.toBeInstanceOf(SandboxCommandError);
  });

  test('times out when command never finishes', async () => {
    const client = createFakeControl();
    await using sandbox = await Sandbox.create({ client });
    await expect(
      sandbox.run('sleep-forever', { timeoutMs: 50, pollIntervalMs: 10 }),
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
  });

  test('writeFile and readFile round-trip via run', async () => {
    const client = createFakeControl();
    await using sandbox = await Sandbox.create({ client });
    await sandbox.writeFile('/tmp/hello', 'hello\n');
    // Fake control returns "hello" for cat '/tmp/hello'
    const contents = await sandbox.readFile('/tmp/hello');
    expect(contents).toBe('hello');
  });

  test('close is idempotent', async () => {
    const client = createFakeControl();
    const sandbox = await Sandbox.create({ client });
    await sandbox.close();
    await sandbox.close();
    expect(sandbox.closed).toBe(true);
    await expect(sandbox.run('echo hi')).rejects.toThrow(/closed/);
  });

  test('exec writes a temp script and runs the interpreter', async () => {
    const client = createFakeControl();
    await using sandbox = await Sandbox.create({ client });
    const result = await sandbox.exec('echo hi');
    expect(result.exitCode).toBe(0);
  });
});
