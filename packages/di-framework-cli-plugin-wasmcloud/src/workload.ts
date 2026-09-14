import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import { type BindingRecord, requirementsFromBindings } from './bindings';
import { deleteApplication, putApplication, waitForApplication } from './controller-client';
import type { DiscoveredCronJob } from './cron';
import type { WasmcloudDeps } from './deps';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from './host-interface';
import {
  APPLICATION_LABEL,
  createDeployIntent,
  ORG_LABEL,
  OWNER_LABEL,
  TEAM_LABEL,
} from './intent';
import type { WasmcloudProject } from './project';
import { asWitIdentifier } from './project';
import type { DiscoveredQueueHandler } from './queues';
import type { ClusterConnection } from './target';
import { defaultProjectRequirements, type WitRequirement } from './wit';

export const MANAGED_BY_LABEL = 'di-framework';
export const WAIT_ATTEMPTS = 30;
export const WAIT_INTERVAL_MS = 2_000;
export const WORKLOAD_DEPLOYMENT_RESOURCE = 'workloaddeployment.runtime.wasmcloud.dev';
export const WORKLOAD_REPLICA_SET_RESOURCE = 'workloadreplicaset.runtime.wasmcloud.dev';

/** Host directory where the storage hostgroup mounts the shared PVC. */
export const HOST_STORAGE_ROOT = '/var/lib/di-framework/storage';
/** Dedicated single-replica hostgroup that mounts persistent application storage. */
export const STORAGE_HOSTGROUP = 'storage';
/** Guest mount path for application SQLite storage. */
export const DEFAULT_STORAGE_MOUNT = '/data';
/** Pinned CronJob invoker image that POSTs to the Wasm HTTP control API. */
export const CRON_INVOKER_IMAGE = 'curlimages/curl:8.11.1';

export function deploymentResourceName(project: WasmcloudProject): string {
  return project.witName;
}

export function generatedManifestPath(project: WasmcloudProject): string {
  return join(project.projectRoot, '.di-framework', 'deploy', 'workload.yaml');
}

export function hostStoragePath(applicationName: string): string {
  return `${HOST_STORAGE_ROOT}/${asWitIdentifier(applicationName)}`;
}

/** Kubernetes Secret that holds DI_CONTROL_TOKEN for a workload. */
export function controlSecretResourceName(workloadName: string): string {
  return `${workloadName}-control`;
}

export interface WorkloadManifestOptions {
  hasActors?: boolean;
  hasPersistentStorage?: boolean;
  replicas?: number;
  storageVolume?: {
    hostPath?: string;
    mountPath?: string;
    volumeName?: string;
  };
  /** Secret name providing control-plane credentials (merged into WASI environment). */
  controlSecretName?: string;
  /** Explicit environment config values (string map for localResources.environment.config). */
  environment?: Record<string, string>;
  /** Stamped from the authenticated principal, never from client intent. */
  org?: string;
  team?: string;
  owner?: string;
  worker?: boolean;
}

export function renderWorkloadManifest(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  requirements: readonly WitRequirement[] = defaultProjectRequirements(),
  bindings: readonly BindingRecord[] = [],
  options?: WorkloadManifestOptions | boolean,
  cronJobs: readonly DiscoveredCronJob[] = [],
  queueHandlers: readonly DiscoveredQueueHandler[] = [],
): string {
  const opts: WorkloadManifestOptions =
    typeof options === 'boolean' ? { hasActors: options } : (options ?? {});
  const hasActors = opts.hasActors ?? false;
  const resolvedHandlers = queueHandlers;
  const isWorker =
    opts.worker ?? (resolvedHandlers.length > 0 && project.applicationType === 'worker');
  const hasQueues = resolvedHandlers.length > 0;
  const needsPersistentStorage =
    opts.hasPersistentStorage ??
    (hasActors || hasQueues || isWorker || project.persistentStorage === true);
  const needsControlHttp = hasActors || cronJobs.length > 0 || hasQueues || isWorker;
  const publicIngress = project.ingress !== false && !isWorker;
  // Cluster Service is required for cron invokers and queue/actor control even when
  // public ingress is disabled.
  const hasHttp = publicIngress || needsControlHttp || needsPersistentStorage;

  if (needsPersistentStorage) {
    if (opts.replicas !== undefined && opts.replicas !== 1) {
      throw new CommandFailure(
        'WASMCLOUD_STORAGE_REPLICA_CONSTRAINT',
        'SQLite-backed workloads require replicas: 1 because the WASI VFS lacks file locking',
        2,
        { replicas: opts.replicas },
      );
    }
  }

  const name = deploymentResourceName(project);
  const labels = [
    `    app.kubernetes.io/managed-by: ${MANAGED_BY_LABEL}`,
    `    app.kubernetes.io/name: ${name}`,
    `    ${APPLICATION_LABEL}: ${yamlQuote(project.applicationName)}`,
    ...(opts.org !== undefined ? [`    ${ORG_LABEL}: ${yamlQuote(opts.org)}`] : []),
    ...(opts.team !== undefined ? [`    ${TEAM_LABEL}: ${yamlQuote(opts.team)}`] : []),
    ...(opts.owner !== undefined ? [`    ${OWNER_LABEL}: ${yamlQuote(opts.owner)}`] : []),
  ].join('\n');

  const volumeName = opts.storageVolume?.volumeName ?? 'app-storage';
  const mountPath =
    opts.storageVolume?.mountPath ??
    (hasActors ? `${DEFAULT_STORAGE_MOUNT}/actors` : DEFAULT_STORAGE_MOUNT);
  const hostPath = opts.storageVolume?.hostPath ?? hostStoragePath(project.applicationName);

  const environment: Record<string, string> = { ...(opts.environment ?? {}) };
  if (needsPersistentStorage) {
    environment.DI_SQLITE_BACKEND = 'wasm';
    environment.DI_STORAGE_DIR = mountPath;
  }
  if (hasActors) environment.ACTOR_STORAGE_DIR = mountPath;
  if (needsPersistentStorage && !hasActors) {
    environment.QUEUE_DB_PATH = `${mountPath}/queue.db`;
    environment.MIGRATION_DB_PATH = `${mountPath}/migrations.db`;
  }
  const controlSecretName =
    opts.controlSecretName ?? (hasHttp ? controlSecretResourceName(name) : undefined);
  const clusterHttpHost = `${name}.${connection.namespace}.svc.cluster.local`;
  const advertisedHttpHost = publicIngress ? project.applicationName : clusterHttpHost;

  if (hasHttp) {
    environment.DI_CONTROL_REJECT_FORWARDED = '1';
    environment.DI_CONTROL_HTTP_HOST = [name, clusterHttpHost].join(',');
  }
  if (cronJobs.length > 0) environment.DI_CRON_MODE = 'external';
  if (hasQueues) {
    environment.DI_QUEUE_MODE = 'sqlite';
    for (const handler of resolvedHandlers) {
      const prefix = `DI_QUEUE_${handler.queueName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
      if (handler.options.concurrency !== undefined) {
        environment[`${prefix}_CONCURRENCY`] = String(handler.options.concurrency);
      }
      if (handler.options.maxRetries !== undefined) {
        environment[`${prefix}_MAX_RETRIES`] = String(handler.options.maxRetries);
      }
      if (handler.options.backoffMs !== undefined) {
        environment[`${prefix}_BACKOFF_MS`] = String(handler.options.backoffMs);
      }
      if (handler.options.timeoutMs !== undefined) {
        environment[`${prefix}_TIMEOUT_MS`] = String(handler.options.timeoutMs);
      }
    }
  }

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

  const localResourcesLines: string[] = [];
  const envKeys = Object.keys(environment).sort();
  if (envKeys.length > 0 || controlSecretName !== undefined) {
    localResourcesLines.push('          localResources:');
    localResourcesLines.push('            environment:');
    if (envKeys.length > 0) {
      localResourcesLines.push('              config:');
      for (const key of envKeys) {
        localResourcesLines.push(`                ${key}: ${yamlQuote(environment[key]!)}`);
      }
    }
    if (controlSecretName !== undefined) {
      localResourcesLines.push('              secretFrom:');
      localResourcesLines.push(`                - name: ${controlSecretName}`);
    }
  } else if (project.allowedIpNameLookups !== undefined) {
    localResourcesLines.push('          localResources:');
  }

  if (needsPersistentStorage) {
    localResourcesLines.push('            volumeMounts:');
    localResourcesLines.push(`              - name: ${volumeName}`);
    localResourcesLines.push(`                mountPath: ${mountPath}`);
  }

  if (project.allowedIpNameLookups !== undefined) {
    localResourcesLines.push(
      `            allowedIpNameLookups: ${JSON.stringify(project.allowedIpNameLookups)}`,
    );
  }

  const hostInterfaces = renderHostInterfacesYaml(
    hostInterfacesFromRequirements(
      hasHttp && !requirements.some((r) => r.package === 'wasi:http' && r.direction === 'export')
        ? [
            ...requirements,
            {
              package: 'wasi:http',
              version: '0.3.0',
              interfaces: ['handler'],
              direction: 'export',
              source: 'control-http',
            },
          ]
        : requirements,
      hasHttp ? { httpHost: advertisedHttpHost } : {},
      bindings.map((binding) => ({
        name: binding.name,
        className: binding.className,
        config: binding.config,
        configFrom: binding.configFrom,
        secretFrom: binding.secretFrom,
      })),
    ),
  );

  const workloadDeployment = `apiVersion: runtime.wasmcloud.dev/v1alpha1
kind: WorkloadDeployment
metadata:
  name: ${name}
  namespace: ${connection.namespace}
  labels:
${labels}
spec:
  replicas: 1
${needsPersistentStorage ? '  deployPolicy: Recreate\n' : ''}  template:
    spec:
      hostSelector:
        hostgroup: ${needsPersistentStorage ? STORAGE_HOSTGROUP : 'default'}
${
  needsPersistentStorage
    ? `      volumes:
        - name: ${volumeName}
          hostPath:
            path: ${yamlQuote(hostPath)}
`
    : ''
}${
  hasHttp
    ? `      kubernetes:
        service:
          name: ${name}
`
    : ''
}      components:
        - name: ${name}
          image: ${yamlQuote(image)}
${localResourcesLines.length > 0 ? `${localResourcesLines.join('\n')}\n` : ''}${hostInterfaces}`;

  sections.push(workloadDeployment);

  for (const job of cronJobs) {
    const jobKebab =
      job.kebabId || asWitIdentifier(job.name || `${job.className}-${job.methodName}`);
    const jobResourceName = `${name}-${jobKebab}`;
    const timeoutSeconds = Math.max(1, Math.ceil((job.timeoutMs ?? 30_000) / 1000));
    // Job deadline must cover image pull + invoke; curl --max-time enforces the app timeout.
    const activeDeadlineSeconds = Math.max(timeoutSeconds + 60, 90);
    const invokeUrl = `http://${name}.${connection.namespace}.svc.cluster.local/_di/cron/${encodeURIComponent(job.jobId)}/invoke`;
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
      activeDeadlineSeconds: ${activeDeadlineSeconds}
      template:
        metadata:
          labels:
${labels.replace(/^/gm, '        ')}
            di-framework.dev/cron-job: ${yamlQuote(job.jobId)}
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cron-invoker
              image: ${yamlQuote(CRON_INVOKER_IMAGE)}
              env:
                - name: DI_CRON_INVOKE_URL
                  value: ${yamlQuote(invokeUrl)}
                - name: DI_CRON_INVOKE_JOB
                  value: ${yamlQuote(job.jobId)}
                - name: DI_CONTROL_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: ${controlSecretName ?? `${name}-control`}
                      key: DI_CONTROL_TOKEN
              command:
                - /bin/sh
                - -ec
                - |
                  set -eu
                  response="$(curl -sS -f -X POST \\
                    -H "Host: ${advertisedHttpHost}" \\
                    -H "content-type: application/json" \\
                    -H "Authorization: Bearer \${DI_CONTROL_TOKEN}" \\
                    --max-time ${timeoutSeconds} \\
                    -d '{}' \\
                    "$DI_CRON_INVOKE_URL")"
                  echo "$response"
                  echo "$response" | grep -q '"completed":true\\|\\"ok\\":true'`);
  }

  return sections.join('\n---\n') + '\n';
}

export async function applyWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  io: CliIo,
  deps: WasmcloudDeps,
  deploymentDigest = image,
): Promise<string> {
  const intent = createDeployIntent(project, deps, image, deploymentDigest);
  const bindings: BindingRecord[] = intent.bindings.map((binding) => ({
    className: binding.className,
    name: binding.name,
    kind: binding.kind,
    requirement: {
      package: binding.package,
      version: binding.version,
      interfaces: [...binding.interfaces],
      direction: 'import',
      source: binding.className,
    },
    secretFrom: binding.secretFrom,
    configFrom: binding.configFrom,
    config: binding.config,
  }));
  const needsHttp =
    intent.ingress !== false ||
    intent.hasActors ||
    intent.cronJobs.length > 0 ||
    intent.queueHandlers.length > 0 ||
    intent.persistentStorage;
  const baseRequirements = needsHttp ? defaultProjectRequirements() : [];
  const manifest = renderWorkloadManifest(
    project,
    connection,
    image,
    [...baseRequirements, ...requirementsFromBindings(bindings)],
    bindings,
    {
      hasActors: intent.hasActors,
      hasPersistentStorage: intent.persistentStorage,
      worker: intent.worker,
    },
    intent.cronJobs,
    intent.queueHandlers,
  );
  const path = generatedManifestPath(project);
  mkdirSync(join(project.projectRoot, '.di-framework', 'deploy'), { recursive: true });
  writeFileSync(path, manifest);
  writeFileSync(
    join(project.projectRoot, '.di-framework', 'deploy', 'intent.json'),
    `${JSON.stringify(intent, null, 2)}\n`,
  );
  await putApplication(connection, intent, io, deps);
  await waitForApplication(connection, intent.witName, deps, io);
  return path;
}

export async function deleteWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  await deleteApplication(connection, deploymentResourceName(project), io, deps);
}

export async function waitForReady(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  io?: CliIo,
): Promise<void> {
  await waitForApplication(connection, deploymentResourceName(project), deps, io);
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

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
