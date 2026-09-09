import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { parseAppCommandArgs } from './args.js';
import { buildComponent } from './build.js';
import { discoverScheduledJobs } from './cron.js';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps.js';
import { resolveApplication } from './discovery.js';
import { loadDeployManifest } from './manifest.js';
import { publishComponent } from './publish.js';
import type { RegistryLocation } from './registry.js';
import { resolveConnection, resolveTarget } from './target.js';
import { applyWorkload, deploymentResourceName } from './workload.js';

export type WasmcloudDeployData = {
  cronJobs?: Array<{ jobId: string; schedule: string | number; cronExpression: string }>;
  application: string;
  target: string;
  namespace: string;
  registry: RegistryLocation;
  image: string;
  publishedImage: string;
  digest: string;
  deploymentDigest: string;
  service: string;
  http?: { url: string; host: string };
  endpoints?: Record<string, string>;
};

export type WasmcloudDeployResult = Omit<CommandResult, 'data' | 'text'> & {
  data: WasmcloudDeployData;
  text: string;
};

export async function runWasmcloudDeploy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<WasmcloudDeployResult> {
  const options = parseAppCommandArgs(args, 'wasmcloud deploy');
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const project = resolveApplication(
    deps.cwd(),
    options.name,
    manifest.workspaceRoot,
    manifest.discovery,
  );
  const build = await buildComponent(project, io, deps);
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);

  io.stdout.write(`Deploying ${project.applicationName} to target ${connection.target}...\n`);
  const image = await publishComponent(project, connection, io, deps, build.deploymentDigest);
  await applyWorkload(project, connection, image.pullReference, io, deps);
  const service = deploymentResourceName(project);

  const hasHttp = project.ingress !== false;
  const cronJobs = discoverScheduledJobs(project.projectRoot);

  return {
    data: {
      application: project.applicationName,
      target: connection.target,
      namespace: connection.namespace,
      registry: connection.registry,
      image: image.pullReference,
      publishedImage: image.pushReference,
      digest: image.artifactDigest,
      deploymentDigest: image.digest,
      service,
      ...(hasHttp && connection.endpoints?.http !== undefined
        ? { http: { url: connection.endpoints.http, host: project.applicationName } }
        : {}),
      ...(connection.endpoints === undefined ? {} : { endpoints: connection.endpoints }),
      ...(cronJobs.length > 0
        ? {
            cronJobs: cronJobs.map((j) => ({
              jobId: j.jobId,
              schedule: j.schedule,
              cronExpression: j.cronExpression,
            })),
          }
        : {}),
    },
    text: `Deployed ${project.applicationName} to ${connection.target} (namespace ${connection.namespace}, ${image.pullReference}).${
      hasHttp && connection.endpoints?.http !== undefined
        ? ` HTTP: ${connection.endpoints.http} with Host: ${project.applicationName}`
        : ''
    }${cronJobs.length > 0 ? ` Scheduled jobs (${cronJobs.length}): ${cronJobs.map((j) => j.jobId).join(', ')}` : ''}`,
  };
}
