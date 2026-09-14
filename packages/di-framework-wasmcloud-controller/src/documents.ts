import { BINDING_CATALOG, isBindingKind } from '@di-framework/wasmcloud';
import {
  APPLICATION_LABEL,
  type DeployBinding,
  type DeployIntent,
  MANAGED_BY_LABEL,
  ORG_LABEL,
  OWNER_LABEL,
  TEAM_LABEL,
} from './intent';

export const HOST_STORAGE_ROOT = '/var/lib/di-framework/storage';
export const STORAGE_HOSTGROUP = 'storage';
export const DEFAULT_STORAGE_MOUNT = '/data';
export const CRON_INVOKER_IMAGE = 'curlimages/curl:8.11.1';

export type ClusterFacts = {
  namespace: string;
};

export type PrincipalStamp = {
  org: string;
  team?: string;
  owner: string;
};

export type KubeDocument = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  [key: string]: unknown;
};

const UNLABELED_HOST_PACKAGES = new Set([
  'wasmcloud:postgres',
  'wasmcloud:keyvalue',
  'wasmcloud:blobstore',
  'wasmcloud:messaging',
  'wasmcloud:secrets',
]);

export function asWitIdentifier(value: string): string {
  const collapsed = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start++;
  while (end > start && collapsed[end - 1] === '-') end--;
  const trimmed = collapsed.slice(start, end);
  return trimmed.length > 0 ? trimmed : 'app';
}

export function hostStoragePath(applicationName: string): string {
  return `${HOST_STORAGE_ROOT}/${asWitIdentifier(applicationName)}`;
}

export function controlSecretName(workloadName: string): string {
  return `${workloadName}-control`;
}

export function resourceLabels(
  intent: DeployIntent,
  stamp: PrincipalStamp,
): Record<string, string> {
  const labels: Record<string, string> = {
    'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
    'app.kubernetes.io/name': intent.witName,
    [APPLICATION_LABEL]: intent.application,
    [ORG_LABEL]: stamp.org,
    [OWNER_LABEL]: stamp.owner,
  };
  if (stamp.team !== undefined && stamp.team !== '') labels[TEAM_LABEL] = stamp.team;
  return labels;
}

export function labelsFromWorkload(
  metadata?: { labels?: Record<string, string> },
): PrincipalStamp | undefined {
  const labels = metadata?.labels ?? {};
  const org = labels[ORG_LABEL];
  if (org === undefined || org === '') return undefined;
  return {
    org,
    team: labels[TEAM_LABEL],
    owner: labels[OWNER_LABEL] ?? '',
  };
}

type HostInterface = {
  name?: string;
  namespace: string;
  package: string;
  version: string;
  interfaces: string[];
  config?: Record<string, string>;
  configFrom?: Array<{ name: string }>;
  secretFrom?: Array<{ name: string }>;
};

function hostInterfaces(intent: DeployIntent, advertisedHttpHost: string, hasHttp: boolean): HostInterface[] {
  const entries: HostInterface[] = [];
  if (hasHttp) {
    entries.push({
      namespace: 'wasi',
      package: 'http',
      version: '0.3.0',
      interfaces: ['handler'],
      config: { host: advertisedHttpHost },
    });
  }
  for (const binding of intent.bindings) {
    const kind = isBindingKind(binding.kind) ? BINDING_CATALOG[binding.kind] : undefined;
    const pkg = binding.package;
    const separator = pkg.indexOf(':');
    const namespace = separator > 0 ? pkg.slice(0, separator) : 'wasi';
    const name = separator > 0 ? pkg.slice(separator + 1) : pkg;
    const unlabeled = UNLABELED_HOST_PACKAGES.has(pkg);
    const interfaces =
      pkg === 'wasmcloud:keyvalue'
        ? binding.interfaces.filter((iface) => iface !== 'types')
        : pkg === 'wasi:http'
          ? binding.interfaces.filter((iface) => iface !== 'client')
          : [...binding.interfaces];
    if (interfaces.length === 0) continue;
    const entry: HostInterface = {
      namespace,
      package: name,
      version: binding.version,
      interfaces,
    };
    if (!unlabeled && (kind?.namedInstance ?? false)) entry.name = binding.name;
    if (binding.config !== undefined) entry.config = { ...binding.config };
    if (binding.configFrom !== undefined) entry.configFrom = [{ name: binding.configFrom }];
    if (binding.secretFrom !== undefined) entry.secretFrom = [{ name: binding.secretFrom }];
    const existing =
      entry.namespace === 'wasi' && entry.package === 'http' && entry.name === undefined
        ? entries.find(
            (candidate) =>
              candidate.namespace === 'wasi' &&
              candidate.package === 'http' &&
              candidate.name === undefined,
          )
        : undefined;
    if (existing === undefined) {
      entries.push(entry);
      continue;
    }
    existing.interfaces = [...new Set([...existing.interfaces, ...entry.interfaces])];
    if (entry.config !== undefined) existing.config = { ...existing.config, ...entry.config };
    if (entry.configFrom !== undefined) {
      existing.configFrom = [...(existing.configFrom ?? []), ...entry.configFrom];
    }
    if (entry.secretFrom !== undefined) {
      existing.secretFrom = [...(existing.secretFrom ?? []), ...entry.secretFrom];
    }
  }
  return entries.filter((entry) => entry.interfaces.length > 0);
}

export function workloadDocuments(
  intent: DeployIntent,
  facts: ClusterFacts,
  stamp: PrincipalStamp,
  controlToken?: string,
): KubeDocument[] {
  const name = intent.witName;
  const labels = resourceLabels(intent, stamp);
  const hasQueues = intent.queueHandlers.length > 0;
  const isWorker = intent.worker;
  const needsPersistentStorage =
    intent.persistentStorage || intent.hasActors || hasQueues || isWorker;
  const needsControlHttp =
    intent.hasActors || intent.cronJobs.length > 0 || hasQueues || isWorker;
  const publicIngress = intent.ingress !== false && !isWorker;
  const hasHttp = publicIngress || needsControlHttp || needsPersistentStorage;
  const volumeName = 'app-storage';
  const mountPath = intent.hasActors ? `${DEFAULT_STORAGE_MOUNT}/actors` : DEFAULT_STORAGE_MOUNT;
  const hostPath = hostStoragePath(intent.application);
  const secretName = controlSecretName(name);
  const clusterHttpHost = `${name}.${facts.namespace}.svc.cluster.local`;
  const advertisedHttpHost = publicIngress ? intent.application : clusterHttpHost;

  const environment: Record<string, string> = {};
  if (needsPersistentStorage) {
    environment.DI_SQLITE_BACKEND = 'wasm';
    environment.DI_STORAGE_DIR = mountPath;
  }
  if (intent.hasActors) environment.ACTOR_STORAGE_DIR = mountPath;
  if (needsPersistentStorage && !intent.hasActors) {
    environment.QUEUE_DB_PATH = `${mountPath}/queue.db`;
    environment.MIGRATION_DB_PATH = `${mountPath}/migrations.db`;
  }
  if (hasHttp) {
    environment.DI_CONTROL_REJECT_FORWARDED = '1';
    environment.DI_CONTROL_HTTP_HOST = [name, clusterHttpHost].join(',');
  }
  if (intent.cronJobs.length > 0) environment.DI_CRON_MODE = 'external';
  if (hasQueues) {
    environment.DI_QUEUE_MODE = 'sqlite';
    for (const handler of intent.queueHandlers) {
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

  const documents: KubeDocument[] = [];

  if (hasHttp && controlToken !== undefined) {
    documents.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace: facts.namespace, labels },
      type: 'Opaque',
      stringData: {
        DI_CONTROL_TOKEN: controlToken,
        DI_CONTROL_IDENTITY: name,
      },
    });
  }

  if (hasHttp) {
    documents.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: facts.namespace, labels },
      spec: {
        type: 'ClusterIP',
        ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }],
      },
    });
  }

  const localResources: Record<string, unknown> = {};
  const envConfig = Object.keys(environment).sort();
  if (envConfig.length > 0 || hasHttp) {
    const environmentBlock: Record<string, unknown> = {};
    if (envConfig.length > 0) {
      environmentBlock.config = Object.fromEntries(envConfig.map((key) => [key, environment[key]!]));
    }
    if (hasHttp) environmentBlock.secretFrom = [{ name: secretName }];
    localResources.environment = environmentBlock;
  }
  if (needsPersistentStorage) {
    localResources.volumeMounts = [{ name: volumeName, mountPath }];
  }
  if (intent.allowedIpNameLookups !== undefined) {
    localResources.allowedIpNameLookups = intent.allowedIpNameLookups;
  }

  const component: Record<string, unknown> = {
    name,
    image: intent.image,
  };
  if (Object.keys(localResources).length > 0) component.localResources = localResources;
  const interfaces = hostInterfaces(intent, advertisedHttpHost, hasHttp);
  if (interfaces.length > 0) component.hostInterfaces = interfaces;

  const templateSpec: Record<string, unknown> = {
    hostSelector: { hostgroup: needsPersistentStorage ? STORAGE_HOSTGROUP : 'default' },
    components: [component],
  };
  if (needsPersistentStorage) {
    templateSpec.volumes = [{ name: volumeName, hostPath: { path: hostPath } }];
  }
  if (hasHttp) {
    templateSpec.kubernetes = { service: { name } };
  }

  const wdSpec: Record<string, unknown> = {
    replicas: 1,
    template: { spec: templateSpec },
  };
  if (needsPersistentStorage) wdSpec.deployPolicy = 'Recreate';

  documents.push({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: { name, namespace: facts.namespace, labels },
    spec: wdSpec,
  });

  for (const job of intent.cronJobs) {
    const jobKebab = job.kebabId || asWitIdentifier(job.name || `${job.className}-${job.methodName}`);
    const jobResourceName = `${name}-${jobKebab}`;
    const timeoutSeconds = Math.max(1, Math.ceil((job.timeoutMs ?? 30_000) / 1000));
    const activeDeadlineSeconds = Math.max(timeoutSeconds + 60, 90);
    const invokeUrl = `http://${name}.${facts.namespace}.svc.cluster.local/_di/cron/${encodeURIComponent(job.jobId)}/invoke`;
    documents.push({
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: {
        name: jobResourceName,
        namespace: facts.namespace,
        labels: { ...labels, 'di-framework.dev/cron-job': job.jobId },
      },
      spec: {
        schedule: job.cronExpression,
        concurrencyPolicy: job.allowConcurrent ? 'Allow' : 'Forbid',
        jobTemplate: {
          spec: {
            activeDeadlineSeconds,
            template: {
              metadata: {
                labels: { ...labels, 'di-framework.dev/cron-job': job.jobId },
              },
              spec: {
                restartPolicy: 'OnFailure',
                containers: [
                  {
                    name: 'cron-invoker',
                    image: CRON_INVOKER_IMAGE,
                    env: [
                      { name: 'DI_CRON_INVOKE_URL', value: invokeUrl },
                      { name: 'DI_CRON_INVOKE_JOB', value: job.jobId },
                      {
                        name: 'DI_CONTROL_TOKEN',
                        valueFrom: { secretKeyRef: { name: secretName, key: 'DI_CONTROL_TOKEN' } },
                      },
                    ],
                    command: [
                      '/bin/sh',
                      '-ec',
                      `set -eu
response="$(curl -sS -f -X POST \\
  -H "Host: ${advertisedHttpHost}" \\
  -H "content-type: application/json" \\
  -H "Authorization: Bearer \${DI_CONTROL_TOKEN}" \\
  --max-time ${timeoutSeconds} \\
  -d '{}' \\
  "$DI_CRON_INVOKE_URL")"
echo "$response"
echo "$response" | grep -q '"completed":true\\|\\"ok\\":true'`,
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });
  }

  return documents;
}

export function isWorkloadReady(document: {
  spec?: { replicas?: number };
  status?: {
    readyReplicas?: number;
    replicas?: { ready?: number; expected?: number };
    conditions?: Array<{ type?: string; status?: string }>;
  };
}): boolean {
  const replicas = document.spec?.replicas ?? 1;
  if ((document.status?.readyReplicas ?? 0) >= replicas) return true;
  if ((document.status?.replicas?.ready ?? 0) >= replicas) return true;
  return (document.status?.conditions ?? []).some(
    (condition) =>
      (condition.type === 'Ready' || condition.type === 'Available') && condition.status === 'True',
  );
}

