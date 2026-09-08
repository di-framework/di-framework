import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { discoverBindings } from './bindings.js';
import { buildComponent, requirementsForProject } from './build.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { resolveDevRunner } from './dev-runner.js';
import { loadProject } from './project.js';
import { invalidUsage, readOptionValue, toolFailed } from './support.js';
import { writeWashDevConfig } from './wash-dev.js';

export type DevOptions = { host: string; port: string };

export function parseDevArgs(args: readonly string[]): DevOptions {
  let host: string | undefined;
  let port: string | undefined;
  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    switch (token) {
      case '--host':
        if (host !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        host = readOptionValue(args, ++position, token);
        break;
      case '--port':
        if (port !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        port = readOptionValue(args, ++position, token);
        break;
      default:
        invalidUsage(`Unknown option or argument: ${token}`, token);
    }
  }
  return { host: host ?? '127.0.0.1', port: port ?? '8000' };
}

export async function runWasmcloudDev(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseDevArgs(args);
  const project = loadProject(deps.cwd());
  await buildComponent(project, io, deps);
  const runner = resolveDevRunner(deps);
  const washConfigPath =
    runner.kind === 'wash'
      ? writeWashDevConfig(
          project,
          requirementsForProject(project, deps),
          discoverBindings(project, deps),
          {
            host: options.host,
            port: options.port,
            postgresUrl: deps.env.WASMCLOUD_POSTGRES_URL,
          },
        )
      : undefined;
  io.stdout.write(`Serving on http://${options.host}:${options.port} (${runner.kind})\n`);
  const served = await deps.runner(
    runner.command,
    runner.args({
      componentPath: project.outputPath,
      host: options.host,
      port: options.port,
      washConfigPath,
    }),
    { cwd: project.projectRoot },
  );
  if (served.exitCode !== 0) {
    throw toolFailed(`${runner.kind} serve`, served.exitCode);
  }
  return {
    data: {
      application: project.applicationName,
      host: options.host,
      port: options.port,
      runner: runner.kind,
    },
    text: 'Dev server stopped.',
  };
}
