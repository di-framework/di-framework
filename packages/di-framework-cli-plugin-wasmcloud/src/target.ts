import { CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import type { DeployManifest, DeployTarget, ExternalTarget, ManagedTarget } from './manifest';
import { loadPlatformOutputs, type PlatformOutputs, resolvePlatformDirectory } from './platform';
import { materializeRegistry, type RegistryLocation } from './registry';

export const CONTROLLER_HOST = 'deploy';

export type ControllerEndpoint = {
  url: string;
  host: string;
};

export type ClusterConnection = {
  target: string;
  namespace: string;
  registry: RegistryLocation;
  controller?: ControllerEndpoint;
  kubeconfig?: string;
  context?: string;
  endpoints?: PlatformOutputs['endpoints'];
  platformRoot?: string;
  stack?: string;
};

export function resolveTarget(manifest: DeployManifest, requested?: string): DeployTarget {
  const name = requested ?? manifest.defaultTarget;
  if (name === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_TARGET_NOT_FOUND',
      `No deployment target selected. Pass --target <name> or set default-target in ${manifest.path}. Known targets: ${Object.keys(manifest.targets).join(', ')}`,
      2,
      { manifestPath: manifest.path, targets: Object.keys(manifest.targets) },
    );
  }
  const target = manifest.targets[name];
  if (target === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_TARGET_NOT_FOUND',
      `Unknown target "${name}". Known targets: ${Object.keys(manifest.targets).join(', ')}`,
      2,
      { target: name, targets: Object.keys(manifest.targets), manifestPath: manifest.path },
    );
  }
  return target;
}

export async function resolveConnection(
  target: DeployTarget,
  workspaceRoot: string,
  manifestPath: string,
  deps: WasmcloudDeps,
): Promise<ClusterConnection> {
  if (target.kind === 'managed') {
    return resolveManagedConnection(target, workspaceRoot, manifestPath, deps);
  }
  return resolveExternalConnection(target);
}

async function resolveManagedConnection(
  target: ManagedTarget,
  workspaceRoot: string,
  manifestPath: string,
  deps: WasmcloudDeps,
): Promise<ClusterConnection> {
  const platformRoot = resolvePlatformDirectory(target, workspaceRoot, manifestPath);
  const outputs = await loadPlatformOutputs(deps, platformRoot, target.stack, target.name);
  const controller =
    outputs.controller ??
    (outputs.endpoints?.http !== undefined
      ? { url: outputs.endpoints.http, host: CONTROLLER_HOST }
      : undefined);
  return {
    target: target.name,
    kubeconfig: outputs.kubeconfig,
    namespace: outputs.namespace,
    registry: outputs.registry,
    context: outputs.context,
    endpoints: outputs.endpoints,
    controller,
    platformRoot,
    stack: target.stack,
  };
}

function resolveExternalConnection(target: ExternalTarget): ClusterConnection {
  return {
    target: target.name,
    namespace: '',
    registry: materializeRegistry(target.registry),
    controller: { url: target.controller, host: target.controllerHost ?? CONTROLLER_HOST },
  };
}
