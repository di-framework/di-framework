import { CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps.js';

export const DEV_RUNNER_ENV = 'DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER';
export type DevRunnerKind = 'wasmtime' | 'wash' | 'jco';

export type DevServeTarget = {
  componentPath: string;
  host: string;
  port: string;
};

export type ResolvedDevRunner = {
  kind: DevRunnerKind;
  command: string;
  args(target: DevServeTarget): string[];
};

const KINDS: readonly DevRunnerKind[] = ['wasmtime', 'wash', 'jco'];

function binaryFor(kind: DevRunnerKind, deps: WasmcloudDeps): string | undefined {
  switch (kind) {
    case 'wasmtime':
      return deps.wasmtimeBinaryPath();
    case 'wash':
      return deps.washBinaryPath();
    case 'jco':
      return deps.nodeBinaryPath();
  }
}

function argsFor(kind: DevRunnerKind, deps: WasmcloudDeps, target: DevServeTarget): string[] {
  switch (kind) {
    case 'wasmtime':
      // qjs guests import wasi:cli@0.2.x; WASI 0.3 HTTP is off unless -S p3 is set.
      return [
        'serve',
        '-S',
        'cli',
        '-S',
        'p3',
        '--addr',
        `${target.host}:${target.port}`,
        target.componentPath,
      ];
    case 'wash':
      return ['dev', '--address', `${target.host}:${target.port}`];
    case 'jco':
      return [
        deps.jcoCliPath(),
        'serve',
        target.componentPath,
        '--host',
        target.host,
        '--port',
        target.port,
      ];
  }
}

export function resolveDevRunner(deps: WasmcloudDeps): ResolvedDevRunner {
  const requested = deps.env[DEV_RUNNER_ENV]?.trim();
  if (requested !== undefined && requested !== '') {
    if (!KINDS.includes(requested as DevRunnerKind)) {
      throw new CommandFailure(
        'WASMCLOUD_DEV_RUNNER_UNKNOWN',
        `Unknown ${DEV_RUNNER_ENV} value "${requested}". Expected wasmtime, wash, or jco.`,
        2,
        { runner: requested },
      );
    }
    const kind = requested as DevRunnerKind;
    const command = binaryFor(kind, deps);
    if (command === undefined) {
      throw new CommandFailure(
        'WASMCLOUD_DEV_RUNNER_REQUIRED',
        `${kind} is required to serve the component locally; install it and make sure it is on PATH`,
        3,
        { tool: kind },
      );
    }
    return { kind, command, args: (target) => argsFor(kind, deps, target) };
  }

  for (const kind of KINDS) {
    const command = binaryFor(kind, deps);
    if (command === undefined) continue;
    return { kind, command, args: (target) => argsFor(kind, deps, target) };
  }

  throw new CommandFailure(
    'WASMCLOUD_DEV_RUNNER_REQUIRED',
    'A local component runner is required (wasmtime 46+, wash, or jco); install one and make sure it is on PATH',
    3,
    { tool: 'dev-runner' },
  );
}
