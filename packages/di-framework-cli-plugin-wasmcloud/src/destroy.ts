import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { parseAppCommandArgs } from './args.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { resolveApplication } from './discovery.js';
import { loadDeployManifest } from './manifest.js';
import { resolveConnection, resolveTarget } from './target.js';
import { deleteWorkload, deploymentResourceName } from './workload.js';

export async function runWasmcloudDestroy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAppCommandArgs(args, 'wasmcloud destroy');
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const project = resolveApplication(
    deps.cwd(),
    options.name,
    manifest.workspaceRoot,
    manifest.discovery,
  );
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
  await deleteWorkload(project, connection, io, deps);
  const service = deploymentResourceName(project);

  return {
    data: {
      application: project.applicationName,
      target: connection.target,
      namespace: connection.namespace,
      service,
    },
    text: `Removed ${project.applicationName} from ${connection.target} (namespace ${connection.namespace}).`,
  };
}
