export const APPLICATION_LABEL = 'di-framework.dev/application';
export const ORG_LABEL = 'di-framework.dev/org';
export const TEAM_LABEL = 'di-framework.dev/team';
export const OWNER_LABEL = 'di-framework.dev/owner';
export const MANAGED_BY_LABEL = 'di-framework';

export const FORBIDDEN_INTENT_FIELDS = [
  'namespace',
  'hostPath',
  'hostSelector',
  'org',
  'team',
  'owner',
  'kubeconfig',
] as const;

export type DeployBinding = {
  className: string;
  name: string;
  kind: string;
  package: string;
  version: string;
  interfaces: string[];
  secretFrom?: string;
  configFrom?: string;
  config?: Record<string, string>;
};

export type CronJobIntent = {
  jobId: string;
  kebabId: string;
  className: string;
  methodName: string;
  cronExpression: string;
  name?: string;
  allowConcurrent: boolean;
  timeoutMs?: number;
};

export type QueueHandlerIntent = {
  className: string;
  methodName: string;
  queueName: string;
  options: {
    maxRetries?: number;
    backoffMs?: number;
    timeoutMs?: number;
    concurrency?: number;
  };
};

export type DeployIntent = {
  application: string;
  witName: string;
  image: string;
  deploymentDigest: string;
  ingress: boolean;
  worker: boolean;
  workload?: string;
  bindings: DeployBinding[];
  hasActors: boolean;
  persistentStorage: boolean;
  allowedIpNameLookups?: string[];
  cronJobs: CronJobIntent[];
  queueHandlers: QueueHandlerIntent[];
};

export class IntentError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'IntentError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntentError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new IntentError(`${field} must be a boolean`);
  return value;
}

export function parseDeployIntent(body: unknown): DeployIntent {
  if (!isRecord(body)) throw new IntentError('Deploy intent must be a JSON object');
  for (const field of FORBIDDEN_INTENT_FIELDS) {
    if (field in body) {
      throw new IntentError(`${field} cannot be set by the client`);
    }
  }
  const image = requiredString(body.image, 'image');
  if (!/^\S+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new IntentError('image must be digest-pinned (sha256)');
  }
  const bindings = Array.isArray(body.bindings) ? body.bindings.map(parseBinding) : [];
  const cronJobs = Array.isArray(body.cronJobs) ? (body.cronJobs as CronJobIntent[]) : [];
  const queueHandlers = Array.isArray(body.queueHandlers)
    ? (body.queueHandlers as QueueHandlerIntent[])
    : [];
  const hasActors = optionalBoolean(body.hasActors, 'hasActors', false);
  return {
    application: requiredString(body.application, 'application'),
    witName: requiredString(body.witName, 'witName'),
    image,
    deploymentDigest: requiredString(body.deploymentDigest, 'deploymentDigest'),
    ingress: optionalBoolean(body.ingress, 'ingress', true),
    worker: optionalBoolean(body.worker, 'worker', false),
    workload: typeof body.workload === 'string' ? body.workload : undefined,
    bindings,
    hasActors,
    persistentStorage: optionalBoolean(body.persistentStorage, 'persistentStorage', false),
    allowedIpNameLookups: Array.isArray(body.allowedIpNameLookups)
      ? body.allowedIpNameLookups.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    cronJobs,
    queueHandlers,
  };
}

function parseBinding(value: unknown): DeployBinding {
  if (!isRecord(value)) throw new IntentError('binding must be an object');
  return {
    className: requiredString(value.className, 'binding.className'),
    name: requiredString(value.name, 'binding.name'),
    kind: requiredString(value.kind, 'binding.kind'),
    package: requiredString(value.package, 'binding.package'),
    version: requiredString(value.version, 'binding.version'),
    interfaces: Array.isArray(value.interfaces)
      ? value.interfaces.filter((entry): entry is string => typeof entry === 'string')
      : [],
    secretFrom: typeof value.secretFrom === 'string' ? value.secretFrom : undefined,
    configFrom: typeof value.configFrom === 'string' ? value.configFrom : undefined,
    config: isRecord(value.config)
      ? Object.fromEntries(
          Object.entries(value.config).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined,
  };
}
