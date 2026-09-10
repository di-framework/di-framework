import { createHash, type Hash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { discoverActors, renderActorsModule } from './actors.js';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings.js';
import { discoverScheduledJobs, renderCronAdapterModule, renderCronInvokerModule } from './cron.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { renderGuestsModule } from './guests.js';
import { OCI_ARTIFACT_PLATFORM } from './oci.js';
import { loadProject, type WasmcloudProject } from './project.js';
import { discoverQueueHandlers, isQueueWorkerProject } from './queues.js';
import { invalidUsage, requireNodeBinary, toolFailed } from './support.js';
import {
  buildWitLock,
  COMPONENT_MODEL,
  defaultProjectRequirements,
  digestBytes,
  queueProjectRequirements,
  renderWorldWit,
  runtimeRequirementsFromJavaScript,
  sqliteProjectRequirements,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_VERSION,
  type WitLock,
  type WitRequirement,
} from './wit.js';
import { renderQueuesModule } from './queues-module.js';

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
  const queueHandlers = discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, queueHandlers);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const actors = discoverActors(project);
  const needsControlHttp =
    isWorker || cronJobs.length > 0 || queueHandlers.length > 0 || actors.length > 0;
  const hasHttp = (project.ingress !== false && !isWorker) || needsControlHttp;
  const baseRequirements = isWorker
    ? queueProjectRequirements()
    : hasHttp
      ? defaultProjectRequirements()
      : [
          {
            package: 'wasi:cli',
            version: '0.3.0',
            interfaces: ['run'],
            direction: 'export' as const,
            source: 'cron-adapter',
          },
        ];
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

async function composeSqliteProvider(
  project: WasmcloudProject,
  deps: WasmcloudDeps,
  io: CliIo,
): Promise<void> {
  const provider = join(deps.assetsDirectory(), 'sqlite', 'di-framework-sqlite.wasm');
  if (!existsSync(provider)) {
    throw new CommandFailure(
      'WASMCLOUD_SQLITE_PROVIDER_MISSING',
      `Packaged SQLite provider missing at ${provider}`,
      3,
      { application: project.applicationName },
    );
  }
  const composed = `${project.outputPath}.composed`;
  const toolsDir = join(deps.assetsDirectory(), '..', '..', 'di-framework-sqlite-component', '.tools', 'bin');
  const envPath = [
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'di-framework-sqlite-component',
      '.tools',
      'bin',
    ),
    process.env.PATH ?? '',
  ].join(':');
  void toolsDir;
  const wac =
    deps.capture('wac', ['--version']) !== undefined
      ? 'wac'
      : join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'di-framework-sqlite-component',
          '.tools',
          'bin',
          'wac',
        );
  io.stdout.write('Composing di-framework:sqlite provider...\n');
  const result = await deps.runCaptured(
    wac,
    ['plug', '--plug', provider, project.outputPath, '-o', composed],
    { cwd: project.projectRoot, env: { ...process.env, PATH: envPath } },
  );
  if (result.exitCode !== 0) {
    throw new CommandFailure(
      'WASMCLOUD_SQLITE_COMPOSE_FAILED',
      `wac plug failed: ${result.stderr || result.stdout}`,
      3,
      { application: project.applicationName, exitCode: result.exitCode },
    );
  }
  writeFileSync(project.outputPath, readFileSync(composed));
  rmSync(composed, { force: true });
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
  const isWorker = isQueueWorkerProject(project, discoverQueueHandlers(project));
  const queueHandlers = discoverQueueHandlers(project);
  const needsControlHttp = isWorker || cronJobs.length > 0;
  const hasHttp = (project.ingress !== false && !isWorker) || needsControlHttp;
  const profile = isWorker
    ? 'wasmcloud-worker'
    : hasHttp
      ? BUILD_PROFILE_NAME
      : CRON_BUILD_PROFILE_NAME;
  const actors = discoverActors(project);
  const requirements = requirementsForProject(project, deps);
  if (actors.length > 0) {
    for (const requirement of sqliteProjectRequirements()) {
      if (
        !requirements.some(
          (entry) =>
            entry.package === requirement.package &&
            entry.interfaces.join(',') === requirement.interfaces.join(','),
        )
      ) {
        requirements.push(requirement);
      }
    }
  }

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
  if (!hasHttp && !isWorker) {
    writeFileSync(join(generatedDirectory, 'cron-adapter.js'), renderCronAdapterModule(cronJobs));
  }
  if (actors.length > 0)
    writeFileSync(join(generatedDirectory, 'actors.js'), renderActorsModule(actors));
  if (queueHandlers.length > 0) {
    writeFileSync(join(generatedDirectory, 'queues.js'), renderQueuesModule(queueHandlers));
  }

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
      cronPath: cronJobs.length > 0 ? join(generatedDirectory, 'cron-invoker.js') : undefined,
      queuesPath: queueHandlers.length > 0 ? join(generatedDirectory, 'queues.js') : undefined,
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

  const needsSqliteCompose = finalRequirements.some(
    (requirement) =>
      requirement.package === 'di-framework:sqlite' && requirement.direction === 'import',
  );
  if (needsSqliteCompose) {
    await composeSqliteProvider(project, deps, io);
  }

  await inspectComponentImports(
    project,
    finalRequirements.filter(
      (requirement) =>
        !(requirement.package === 'di-framework:sqlite' && requirement.direction === 'import'),
    ),
    deps,
  );

  const deploymentDigest = canonicalBuildDigest(
    bundledJavaScript,
    generatedWit,
    join(generatedDirectory, 'oci-config.json'),
    lock,
    profile,
    needsSqliteCompose
      ? join(deps.assetsDirectory(), 'sqlite', 'di-framework-sqlite.wasm')
      : undefined,
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
 * WIT lock, OCI configuration, pinned build profile, and (when composed) the
 * pinned SQLite provider artifact — not the final componentize output bytes.
 */
export function canonicalBuildDigest(
  bundledJavaScript: string,
  witDirectory: string,
  ociConfig: string,
  lock: WitLock,
  profile: string = BUILD_PROFILE_NAME,
  sqliteProvider?: string,
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
  if (sqliteProvider !== undefined) {
    addDigestEntry(hash, 'sqlite-provider', readFileSync(sqliteProvider));
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
