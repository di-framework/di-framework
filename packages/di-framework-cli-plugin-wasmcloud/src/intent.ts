import { discoverActors } from './actors';
import { type BindingRecord, discoverBindings } from './bindings';
import { type DiscoveredCronJob, discoverScheduledJobs } from './cron';
import type { WasmcloudDeps } from './deps';
import type { WasmcloudProject } from './project';
import { type DiscoveredQueueHandler, discoverQueueHandlers, isQueueWorkerProject } from './queues';

export const APPLICATION_LABEL = 'di-framework.dev/application';
export const ORG_LABEL = 'di-framework.dev/org';
export const TEAM_LABEL = 'di-framework.dev/team';
export const OWNER_LABEL = 'di-framework.dev/owner';

export type DeployBinding = {
  className: string;
  name: string;
  kind: BindingRecord['kind'];
  package: string;
  version: string;
  interfaces: string[];
  secretFrom?: string;
  configFrom?: string;
  config?: Record<string, string>;
};

/** Client → controller. No namespace, hostPath, hostSelector, org, or team. */
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
  cronJobs: DiscoveredCronJob[];
  queueHandlers: DiscoveredQueueHandler[];
};

export function bindingsToIntent(bindings: readonly BindingRecord[]): DeployBinding[] {
  return bindings.map((binding) => ({
    className: binding.className,
    name: binding.name,
    kind: binding.kind,
    package: binding.requirement.package,
    version: binding.requirement.version,
    interfaces: [...binding.requirement.interfaces],
    secretFrom: binding.secretFrom,
    configFrom: binding.configFrom,
    config: binding.config,
  }));
}

export function createDeployIntent(
  project: WasmcloudProject,
  deps: WasmcloudDeps,
  image: string,
  deploymentDigest: string,
): DeployIntent {
  const bindings = discoverBindings(project, deps);
  const queueHandlers = discoverQueueHandlers(project);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const hasActors = discoverActors(project).length > 0 || project.actors === true;
  const worker = isQueueWorkerProject(project, queueHandlers);
  return {
    application: project.applicationName,
    witName: project.witName,
    image,
    deploymentDigest,
    ingress: project.ingress !== false,
    worker,
    bindings: bindingsToIntent(bindings),
    hasActors,
    persistentStorage: project.persistentStorage === true || hasActors || queueHandlers.length > 0,
    allowedIpNameLookups: project.allowedIpNameLookups,
    cronJobs,
    queueHandlers,
  };
}
