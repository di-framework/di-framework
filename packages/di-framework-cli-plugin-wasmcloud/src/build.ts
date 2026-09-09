import { createHash, type Hash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { discoverActors, renderActorsModule } from './actors.js';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings.js';
import { discoverScheduledJobs, renderCronAdapterModule, renderCronInvokerModule } from './cron.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { renderGuestsModule } from './guests.js';
import { OCI_ARTIFACT_PLATFORM } from './oci.js';
import { loadProject, type WasmcloudProject } from './project.js';
import { invalidUsage, requireNodeBinary, toolFailed } from './support.js';
import {
  buildWitLock,
  COMPONENT_MODEL,
  defaultProjectRequirements,
  digestBytes,
  renderWorldWit,
  runtimeRequirementsFromJavaScript,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_VERSION,
  type WitLock,
  type WitRequirement,
} from './wit.js';

export { COMPONENT_MODEL, WASI_HTTP_INTERFACE, WASI_HTTP_VERSION };
export const BUILD_PROFILE_NAME = 'wasmcloud-http';
export const CRON_BUILD_PROFILE_NAME = 'wasmcloud-cron';
export { BUILD_PROFILE_NAME as BUILD_PROFILE };

export type BuildSummary = {
  application: string;
  artifactDigest: string;
  component: string;
  componentModel: string;
  deploymentDigest: string;
  entry: string;
  profile: string;
  actors?: string[];
};

export function requirementsForProject(
  project: WasmcloudProject,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): WitRequirement[] {
  const bindings = discoverBindings(project, deps);
  const baseRequirements = project.ingress !== false ? defaultProjectRequirements() : [];
  return [...baseRequirements, ...requirementsFromBindings(bindings)];
}

function writeGuestsModule(generatedDirectory: string, bindings: readonly BindingRecord[]): void {
  writeFileSync(join(generatedDirectory, 'guests.js'), renderGuestsModule(bindings));
}

async function runComponentize(
  project: WasmcloudProject,
  generatedWit: string,
  bundledJavaScript: string,
  deps: WasmcloudDeps,
): Promise<{ exitCode: number; tool: string }> {
  const qjsCli = deps.componentizeQjsPath();
  if (qjsCli !== undefined) {
    const result = await deps.runner(
      qjsCli,
      [
        '--wit',
        generatedWit,
        '--js',
        bundledJavaScript,
        '-n',
        'application',
        '-o',
        project.outputPath,
      ],
      { cwd: project.projectRoot },
    );
    return { exitCode: result.exitCode, tool: 'componentize-qjs' };
  }
  const result = await deps.runner(
    requireNodeBinary(deps.nodeBinaryPath()),
    [
      deps.jcoCliPath(),
      'componentize',
      '--backend',
      'qjs',
      '-w',
      generatedWit,
      '-n',
      'application',
      '-o',
      project.outputPath,
      bundledJavaScript,
    ],
    { cwd: project.projectRoot },
  );
  return { exitCode: result.exitCode, tool: 'jco componentize' };
}

function isWasmMagic(path: string): boolean {
  const header = readFileSync(path).subarray(0, 4);
  return (
    header.length === 4 &&
    header[0] === 0 &&
    header[1] === 0x61 &&
    header[2] === 0x73 &&
    header[3] === 0x6d
  );
}

async function inspectComponentImports(
  project: WasmcloudProject,
  requirements: readonly WitRequirement[],
  deps: WasmcloudDeps,
): Promise<void> {
  if (!isWasmMagic(project.outputPath)) return;
  const captured = await deps.runCaptured(
    requireNodeBinary(deps.nodeBinaryPath()),
    [deps.jcoCliPath(), 'wit', project.outputPath],
    { cwd: project.projectRoot },
  );
  if (captured.exitCode !== 0) {
    throw new CommandFailure(
      'WASMCLOUD_COMPONENT_IMPORTS_UNREADABLE',
      `Could not inspect component imports for ${project.applicationName}`,
      3,
      { application: project.applicationName },
    );
  }
  const wit = `${captured.stdout}\n${captured.stderr}`;
  for (const requirement of requirements) {
    if (requirement.direction !== 'import') continue;
    for (const iface of requirement.interfaces) {
      const needle = `${requirement.package}/${iface}@${requirement.version}`;
      if (!wit.includes(needle)) {
        throw new CommandFailure(
          'WASMCLOUD_COMPONENT_IMPORTS_MISMATCH',
          `Compiled component is missing declared import ${needle} (binding ${requirement.source})`,
          3,
          { application: project.applicationName, source: requirement.source, iface },
        );
      }
    }
  }
}

/** The disposable `.di-framework/` build directory: WIT world, bundle, and manifests. */
export async function buildComponent(
  project: WasmcloudProject,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<BuildSummary> {
  const generatedDirectory = join(project.projectRoot, '.di-framework');
  const generatedWit = join(generatedDirectory, 'wit');
  const bundledJavaScript = join(generatedDirectory, 'component.js');
  const bindings = discoverBindings(project, deps);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const hasHttp = project.ingress !== false;
  const profile = hasHttp ? BUILD_PROFILE_NAME : CRON_BUILD_PROFILE_NAME;
  const actors = discoverActors(project);
  const requirements = requirementsForProject(project, deps);

  rmSync(generatedDirectory, { recursive: true, force: true });
  mkdirSync(join(generatedWit, 'deps'), { recursive: true });
  mkdirSync(dirname(project.outputPath), { recursive: true });
  cpSync(join(deps.assetsDirectory(), 'wit', 'deps'), join(generatedWit, 'deps'), {
    recursive: true,
  });

  writeFileSync(
    join(generatedWit, 'world.wit'),
    renderWorldWit(project.witName, project.version, requirements),
  );
  let lock = buildWitLock(requirements, join(generatedWit, 'deps'));
  writeFileSync(join(generatedDirectory, 'wit.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(
    join(generatedDirectory, 'oci-config.json'),
    `${JSON.stringify(OCI_ARTIFACT_PLATFORM, null, 2)}\n`,
  );
  if (bindings.length > 0) writeGuestsModule(generatedDirectory, bindings);
  if (cronJobs.length > 0) {
    writeFileSync(join(generatedDirectory, 'cron.json'), `${JSON.stringify(cronJobs, null, 2)}\n`);
  }
  if (cronJobs.length > 0 || !hasHttp) {
    writeFileSync(join(generatedDirectory, 'cron-invoker.js'), renderCronInvokerModule(cronJobs));
  }
  if (!hasHttp) {
    writeFileSync(join(generatedDirectory, 'cron-adapter.js'), renderCronAdapterModule(cronJobs));
  }
  if (actors.length > 0)
    writeFileSync(join(generatedDirectory, 'actors.js'), renderActorsModule(actors));

  io.stdout.write(`Building ${project.applicationName}...\n`);
  try {
    await deps.bundler({
      adapterPath: hasHttp
        ? join(deps.assetsDirectory(), 'http-adapter.js')
        : join(generatedDirectory, 'cron-adapter.js'),
      entryPath: project.entryPath,
      outFile: bundledJavaScript,
      guestsPath: bindings.length > 0 ? join(generatedDirectory, 'guests.js') : undefined,
      actorsPath: actors.length > 0 ? join(generatedDirectory, 'actors.js') : undefined,
      projectRoot: project.projectRoot,
    });
  } catch (error) {
    throw new CommandFailure(
      'WASMCLOUD_BUILD_FAILED',
      `Bundling failed: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { entry: relative(project.projectRoot, project.entryPath) },
    );
  }

  const runtimeRequirements = runtimeRequirementsFromJavaScript(
    readFileSync(bundledJavaScript, 'utf8'),
  );
  const finalRequirements = [...requirements, ...runtimeRequirements];
  if (runtimeRequirements.length > 0) {
    writeFileSync(
      join(generatedWit, 'world.wit'),
      renderWorldWit(project.witName, project.version, finalRequirements),
    );
    lock = buildWitLock(finalRequirements, join(generatedWit, 'deps'));
    writeFileSync(join(generatedDirectory, 'wit.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }

  const componentize = await runComponentize(project, generatedWit, bundledJavaScript, deps);
  if (componentize.exitCode !== 0) {
    throw toolFailed(componentize.tool, componentize.exitCode);
  }
  await inspectComponentImports(project, finalRequirements, deps);

  const deploymentDigest = canonicalBuildDigest(
    bundledJavaScript,
    generatedWit,
    join(generatedDirectory, 'oci-config.json'),
    lock,
    profile,
  );
  const artifactDigest = digestBytes(readFileSync(project.outputPath));
  const summary: BuildSummary = {
    application: project.applicationName,
    artifactDigest,
    component: relative(project.projectRoot, project.outputPath),
    componentModel: COMPONENT_MODEL,
    deploymentDigest,
    entry: relative(project.projectRoot, project.entryPath),
    profile,
    ...(actors.length > 0 ? { actors: actors.map((a) => a.actorName) } : {}),
  };
  writeFileSync(
    join(generatedDirectory, 'build.json'),
    `${JSON.stringify({ schemaVersion: 1, ...summary }, null, 2)}\n`,
  );

  io.stdout.write(`Built ${summary.component}\n`);
  return summary;
}

/**
 * Stable logical version for deployment. ComponentizeJS snapshots can contain
 * nondeterministic engine bytes, so the rollout key is the canonical bundle,
 * WIT lock, OCI configuration, and pinned build profile instead of the final bytes.
 */
export function canonicalBuildDigest(
  bundledJavaScript: string,
  witDirectory: string,
  ociConfig: string,
  lock: WitLock,
  profile: string = BUILD_PROFILE_NAME,
): string {
  const hash = createHash('sha256');
  addDigestEntry(hash, 'profile', `${profile}\n${COMPONENT_MODEL}`);
  addDigestEntry(hash, 'wit-lock', JSON.stringify(lock));
  addDigestEntry(hash, 'bundle', readFileSync(bundledJavaScript));
  addDigestEntry(hash, 'oci-config', readFileSync(ociConfig));
  for (const file of listFiles(witDirectory)) {
    const name = relative(witDirectory, file).split(sep).join('/');
    addDigestEntry(hash, `wit/${name}`, readFileSync(file));
  }
  return hash.digest('hex');
}

function addDigestEntry(hash: Hash, name: string, content: string | Buffer): void {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  hash.update(`${name.length}:${name}:${bytes.length}:`);
  hash.update(bytes);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

export async function runWasmcloudBuild(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  if (args.length > 0) {
    invalidUsage(`wasmcloud build does not accept arguments: ${args[0]}`, args[0] ?? '');
  }
  const project = loadProject(deps.cwd());
  const summary = await buildComponent(project, io, deps);
  return { data: { ...summary }, text: `Built ${summary.component}` };
}
