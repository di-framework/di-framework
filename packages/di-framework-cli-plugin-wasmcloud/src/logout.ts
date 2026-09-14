import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { parseAppCommandArgs } from './args';
import { deleteCredential } from './credentials';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { loadDeployManifest } from './manifest';
import { invalidUsage } from './support';
import { resolveTarget } from './target';

export async function runWasmcloudLogout(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAppCommandArgs(args, 'wasmcloud logout');
  if (options.name !== undefined) {
    invalidUsage(`Unexpected argument: ${options.name}`, options.name, { command: 'wasmcloud logout' });
  }
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const removed = deleteCredential(deps.credentialsPath(), target.name);
  return {
    data: { target: target.name, removed },
    text: removed
      ? `Logged out of ${target.name}.`
      : `No stored credentials for ${target.name}.`,
  };
}
