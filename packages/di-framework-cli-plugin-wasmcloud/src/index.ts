import { defineExtension } from '@di-framework/cli-extension';
import { createWasmcloudCommand } from './command.js';

export { parseAppCommandArgs, parsePlatformCommandArgs, parsePlatformInitArgs } from './args.js';
export {
  type BindingRecord,
  defaultSecretName,
  discoverBindings,
  parseBindingsFile,
  requirementsFromBindings,
} from './bindings.js';
export {
  BUILD_PROFILE,
  buildComponent,
  canonicalBuildDigest,
  requirementsForProject,
  runWasmcloudBuild,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_VERSION,
} from './build.js';
export { createWasmcloudCommand } from './command.js';
export {
  runWasmcloudDeploy,
  type WasmcloudDeployData,
  type WasmcloudDeployResult,
} from './deploy.js';
export {
  COMPONENT_IMPORT_EXTERNAL,
  COMPONENTIZE_QJS_ENV,
  DEFAULT_DEPS,
  nodeCompatibilityPlugin,
  resolveComponentizeQjsPath,
  type WasmcloudDeps,
} from './deps.js';
export { runWasmcloudDestroy } from './destroy.js';
export { parseDevArgs, runWasmcloudDev } from './dev.js';
export { DEV_RUNNER_ENV, resolveDevRunner } from './dev-runner.js';
export { emptyGuestsModule, renderGuestsModule, WASMCLOUD_GUESTS_GLOBAL } from './guests.js';
export { renderWashDevYaml, writeWashDevConfig } from './wash-dev.js';
export {
  discoverProjects,
  findConfigFiles,
  resolveApplication,
} from './discovery.js';
export { runWasmcloudDoctor } from './doctor.js';
export { hostInterfacesFromRequirements } from './host-interface.js';
export {
  DEPLOY_MANIFEST_NAME,
  type DeployManifest,
  type DeployTarget,
  loadDeployManifest,
  parseDeployManifest,
} from './manifest.js';
export { OCI_ARTIFACT_PLATFORM } from './oci.js';
export {
  loadPlatformOutputs,
  PLATFORM_OUTPUT_SCHEMA_VERSION,
  type PlatformOutputs,
  resolvePlatformDirectory,
  runWasmcloudPlatformDeploy,
  runWasmcloudPlatformDestroy,
} from './platform.js';
export {
  createPlatformProjectName,
  LOCAL_PLATFORM_PATH,
  PLATFORM_PROJECT_TOKEN,
  PLATFORM_START_COMMAND,
  runWasmcloudPlatformInit,
} from './platform-init.js';
export {
  asWitIdentifier,
  CONFIG_FILE_NAME,
  findUp,
  loadProject,
  resolveInside,
  type WasmcloudProject,
} from './project.js';
export { contentDigest, ociReference, projectRelativePath, publishComponent } from './publish.js';
export { pulumiEnvironment, runPulumi } from './pulumi.js';
export {
  materializeRegistry,
  type RegistryInput,
  type RegistryLocation,
  registryReferenceHost,
  registryUsesPlainHttp,
} from './registry.js';
export { resolveConnection, resolveTarget } from './target.js';
export {
  aggregateRequirements,
  COMPONENT_MODEL,
  defaultProjectRequirements,
  HTTP_ADAPTER_REQUIREMENTS,
  renderWorldWit,
  type WitRequirement,
} from './wit.js';
export {
  applyWorkload,
  deleteWorkload,
  isReady,
  renderWorkloadManifest,
} from './workload.js';

export default defineExtension({
  schemaVersion: 1,
  name: 'wasmcloud',
  description: 'Build, serve, and deploy DI Framework apps as wasmCloud components',
  command: createWasmcloudCommand(),
});
