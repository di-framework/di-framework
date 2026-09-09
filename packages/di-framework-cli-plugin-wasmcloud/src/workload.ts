import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings.js';
import { type DiscoveredCronJob, discoverScheduledJobs } from './cron.js';
import type { WasmcloudDeps } from './deps.js';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from './host-interface.js';
import { captureKubectl, runKubectl } from './kubernetes.js';
import type { WasmcloudProject } from './project.js';
import { asWitIdentifier } from './project.js';
import {
  type DiscoveredQueueHandler,
  discoverQueueHandlers,
  isQueueWorkerProject,
} from './queues.js';
import type { ClusterConnection } from './target.js';
import {
  defaultProjectRequirements,
  queueProjectRequirements,
  type WitRequirement,
} from './wit.js';

export const MANAGED_BY_LABEL = 'di-framework';
export const WAIT_ATTEMPTS = 30;
export const WAIT_INTERVAL_MS = 2_000;
export const WORKLOAD_DEPLOYMENT_RESOURCE = 'workloaddeployment.runtime.wasmcloud.dev';
export const WORKLOAD_REPLICA_SET_RESOURCE = 'workloadreplicaset.runtime.wasmcloud.dev';

export function deploymentResourceName(project: WasmcloudProject): string {
  return project.witName;
}

export function generatedManifestPath(project: WasmcloudProject): string {
  return join(project.projectRoot, '.di-framework', 'deploy', 'workload.yaml');
}

export function renderQueueConsumersYaml(queueHandlers: readonly DiscoveredQueueHandler[]): string {
  if (queueHandlers.length === 0) return '';
  const lines = ['          queueConsumers:'];
  for (const h of queueHandlers) {
    lines.push(`            - queue: ${yamlQuote(h.queueName)}`);
    if (h.options.concurrency !== undefined) {
      lines.push(`              concurrency: ${h.options.concurrency}`);
    }
    if (h.options.maxRetries !== undefined) {
      lines.push(`              maxRetries: ${h.options.maxRetries}`);
    }
    if (h.options.backoffMs !== undefined) {
      lines.push(`              backoffMs: ${h.options.backoffMs}`);
    }
    if (h.options.timeoutMs !== undefined) {
      lines.push(`              timeoutMs: ${h.options.timeoutMs}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function renderWorkloadManifest(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  requirements: readonly WitRequirement[] = defaultProjectRequirements(),
  bindings: readonly BindingRecord[] = [],
  cronJobs: readonly DiscoveredCronJob[] = [],
  queueHandlers: readonly DiscoveredQueueHandler[] = [],
): string {
  const name = deploymentResourceName(project);
  const labels = [
    `    app.kubernetes.io/managed-by: ${MANAGED_BY_LABEL}`,
    `    app.kubernetes.io/name: ${name}`,
    `    di-framework.dev/application: ${yamlQuote(project.applicationName)}`,
  ].join('\n');

  const resolvedHandlers =
    queueHandlers.length > 0 ? queueHandlers : discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, resolvedHandlers);
  const hasHttp = project.ingress !== false && !isWorker;
  const sections: string[] = [];

  if (hasHttp) {
    sections.push(`apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${connection.namespace}
  labels:
${labels}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP`);
  }

  const cronEnv =
    cronJobs.length > 0
      ? `          env:
            - name: DI_CRON_MODE
              value: "external"
`
      : '';

  const workloadDeployment = `apiVersion: runtime.wasmcloud.dev/v1alpha1
kind: WorkloadDeployment
metadata:
  name: ${name}
  namespace: ${connection.namespace}
  labels:
${labels}
spec:
  replicas: 1
  template:
    spec:
      hostSelector:
        hostgroup: default
${
  hasHttp
    ? `      kubernetes:
        service:
          name: ${name}
`
    : ''
}      components:
        - name: ${name}
          image: ${yamlQuote(image)}
${cronEnv}${
  project.allowedIpNameLookups === undefined
    ? ''
    : `          localResources:
            allowedIpNameLookups: ${JSON.stringify(project.allowedIpNameLookups)}
`
}${isWorker ? renderQueueConsumersYaml(resolvedHandlers) : ''}${renderHostInterfacesYaml(
  hostInterfacesFromRequirements(
    requirements,
    hasHttp ? { httpHost: project.applicationName } : {},
    bindings.map((binding) => ({
      name: binding.name,
      className: binding.className,
      config: binding.config,
      configFrom: binding.configFrom,
      secretFrom: binding.secretFrom,
    })),
  ),
)}`;

  sections.push(workloadDeployment);

  for (const job of cronJobs) {
    const jobKebab =
      job.kebabId || asWitIdentifier(job.name || `${job.className}-${job.methodName}`);
    const jobResourceName = `${name}-${jobKebab}`;
    sections.push(`apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${jobResourceName}
  namespace: ${connection.namespace}
  labels:
${labels}
    di-framework.dev/cron-job: ${yamlQuote(job.jobId)}
spec:
  schedule: ${yamlQuote(job.cronExpression)}
  concurrencyPolicy: ${job.allowConcurrent ? 'Allow' : 'Forbid'}
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
${labels}
            di-framework.dev/cron-job: ${yamlQuote(job.jobId)}
        spec:
          restartPolicy: OnFailure
          containers:
            - name: scheduler-dispatch
              image: ${yamlQuote(image)}
              env:
                - name: DI_CRON_MODE
                  value: "external"
                - name: DI_CRON_INVOKE_JOB
                  value: ${yamlQuote(job.jobId)}
              args:
                - "cron:invoke"
                - ${yamlQuote(job.jobId)}`);
  }

  return sections.join('\n---\n') + '\n';
}

export async function applyWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<string> {
  const bindings = discoverBindings(project, deps);
  const queueHandlers = discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, queueHandlers);
  const baseRequirements = isWorker
    ? queueProjectRequirements()
    : project.ingress !== false
      ? defaultProjectRequirements()
      : [];
  const requirements = [...baseRequirements, ...requirementsFromBindings(bindings)];
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const manifest = renderWorkloadManifest(
    project,
    connection,
    image,
    requirements,
    bindings,
    cronJobs,
    queueHandlers,
  );
  const path = generatedManifestPath(project);
  mkdirSync(join(project.projectRoot, '.di-framework', 'deploy'), { recursive: true });
  writeFileSync(path, manifest);
  const name = deploymentResourceName(project);
  io.stdout.write(`Applying WorkloadDeployment ${name} in ${connection.namespace}...\n`);
  await runKubectl(deps, connection, ['apply', '-f', path], project.projectRoot);
  await waitForReady(project, connection, deps, io);
  return path;
}

export async function deleteWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  const name = deploymentResourceName(project);
  io.stdout.write(`Removing WorkloadDeployment ${name} from ${connection.namespace}...\n`);
  await runKubectl(
    deps,
    connection,
    [
      'delete',
      `${WORKLOAD_DEPLOYMENT_RESOURCE},service,cronjob`,
      '-l',
      `app.kubernetes.io/name=${name}`,
      '--ignore-not-found',
    ],
    project.projectRoot,
  );
}

export async function waitForReady(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  io?: CliIo,
): Promise<void> {
  const name = deploymentResourceName(project);
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    const result = await captureKubectl(
      deps,
      connection,
      ['get', WORKLOAD_DEPLOYMENT_RESOURCE, name, '-o', 'json'],
      project.projectRoot,
    );
    if (result.exitCode === 0 && isReady(result.stdout)) return;
    await deps.wait(WAIT_INTERVAL_MS);
  }
  const diagnostics = await deploymentDiagnostics(project, connection, deps);
  if (io !== undefined) {
    io.stderr.write(
      `WorkloadDeployment ${name} did not become ready. Kubernetes diagnostics follow:\n${diagnostics}\n`,
    );
  }
  throw new CommandFailure(
    'WASMCLOUD_DEPLOYMENT_NOT_READY',
    `WorkloadDeployment ${name} in ${connection.namespace} did not become ready`,
    3,
    {
      application: project.applicationName,
      namespace: connection.namespace,
      name,
      diagnostics,
    },
  );
}

export function isReady(stdout: string): boolean {
  try {
    const document = JSON.parse(stdout) as {
      spec?: { replicas?: number };
      status?: {
        readyReplicas?: number;
        replicas?: { ready?: number; expected?: number };
        conditions?: Array<{ type?: string; status?: string }>;
      };
    };
    const replicas = document.spec?.replicas ?? 1;
    if ((document.status?.readyReplicas ?? 0) >= replicas) return true;
    if ((document.status?.replicas?.ready ?? 0) >= replicas) return true;
    return (document.status?.conditions ?? []).some(
      (condition) =>
        (condition.type === 'Ready' || condition.type === 'Available') &&
        condition.status === 'True',
    );
  } catch {
    return false;
  }
}

async function deploymentDiagnostics(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<string> {
  const name = deploymentResourceName(project);
  const commands: Array<{ title: string; args: string[] }> = [
    {
      title: 'WorkloadDeployment',
      args: ['get', WORKLOAD_DEPLOYMENT_RESOURCE, name, '-o', 'yaml'],
    },
    {
      title: 'WorkloadReplicaSets',
      args: [
        'get',
        WORKLOAD_REPLICA_SET_RESOURCE,
        '-l',
        `runtime.wasmcloud.dev/workload-deployment=${name}`,
        '-o',
        'wide',
      ],
    },
    {
      title: 'wasmCloud host pods',
      args: ['get', 'pods', '-l', 'wasmcloud.com/hostgroup=default', '-o', 'wide'],
    },
    {
      title: 'wasmCloud host logs',
      args: ['logs', 'deployment/hostgroup-default', '--tail=100'],
    },
  ];
  const sections: string[] = [];
  for (const command of commands) {
    const result = await captureKubectl(deps, connection, command.args, project.projectRoot);
    const output =
      result.stdout.trim() || result.stderr.trim() || `(kubectl exited ${result.exitCode})`;
    sections.push(`--- ${command.title} ---\n${output}`);
  }
  return sections.join('\n');
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
