import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import type { BindingRecord } from './bindings';
import type { WasmcloudDeps } from './deps';
import { captureKubectl, runKubectl } from './kubernetes';
import type { WasmcloudProject } from './project';
import type { ClusterConnection } from './target';

export const ASSOCIATION_WORKLOAD_LABEL = 'di-framework.dev/binding-workload';
const RESOURCE = 'servicebindings.platform.di-framework.dev';
type Association = {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    generation?: number;
    deletionTimestamp?: string;
  };
  spec: { serviceName: string; bindingName: string; capability: string; workloadName?: string };
  status?: {
    observedGeneration?: number;
    serviceRef?: { uid?: string };
    conditions?: { type: string; status: string; message?: string }[];
  };
};
export function associationName(workload: string, bindingName: string): string {
  return `di-bind-${createHash('sha256')
    .update(JSON.stringify([workload, bindingName]))
    .digest('hex')
    .slice(0, 32)}`;
}
function fail(message: string): never {
  throw new CommandFailure('WASMCLOUD_MANAGED_BINDING_FAILED', message, 3);
}

export async function applyManagedBindings(
  project: WasmcloudProject,
  connection: ClusterConnection,
  bindings: readonly BindingRecord[],
  deps: WasmcloudDeps,
): Promise<Set<string>> {
  const managed = bindings.filter((b) => b.serviceName !== undefined);
  const desired = new Set(managed.map((b) => associationName(project.witName, b.name)));
  if (!managed.length) return desired;
  const peersResult = await captureKubectl(
    deps,
    connection,
    ['get', RESOURCE, '-o', 'json'],
    project.projectRoot,
  );
  if (peersResult.exitCode !== 0)
    fail(
      'Cannot read ServiceBindings; install the platform backing-service CRDs and check tenant permissions',
    );
  const peers = (JSON.parse(peersResult.stdout) as { items: Association[] }).items;
  const serviceUids = new Map<string, string>();
  // Validate every reference and ownership before applying any associations.
  for (const binding of managed) {
    const result = await captureKubectl(
      deps,
      connection,
      ['get', 'backingservices.platform.di-framework.dev', binding.serviceName!, '-o', 'json'],
      project.projectRoot,
    );
    if (result.exitCode !== 0)
      fail(
        `BackingService ${binding.serviceName} is unavailable in namespace ${connection.namespace}`,
      );
    const service = JSON.parse(result.stdout) as {
      metadata: { uid: string; deletionTimestamp?: string };
      spec: { type: string };
    };
    if (service.metadata.deletionTimestamp)
      fail(`BackingService ${binding.serviceName} is deleting; new associations are refused`);
    if (service.spec.type !== 'postgres')
      fail(`BackingService ${binding.serviceName} must have type postgres`);
    serviceUids.set(binding.name, service.metadata.uid);
    for (const peer of peers) {
      if (peer.metadata.name === associationName(project.witName, binding.name)) {
        if (
          peer.metadata.labels?.[ASSOCIATION_WORKLOAD_LABEL] !== project.witName ||
          peer.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'di-framework'
        )
          fail(`Refusing to adopt ServiceBinding ${peer.metadata.name}`);
        if (peer.metadata.deletionTimestamp)
          fail(`ServiceBinding ${peer.metadata.name} is still deleting`);
      } else if (
        peer.spec.bindingName === binding.name &&
        !peer.metadata.deletionTimestamp &&
        (peer.spec.serviceName !== binding.serviceName || peer.spec.capability !== 'postgres')
      ) {
        fail(
          `Binding ${binding.name} is already associated with another service by ${peer.metadata.name}`,
        );
      }
    }
  }
  const items = managed.map((binding) => ({
    apiVersion: 'platform.di-framework.dev/v1alpha1',
    kind: 'ServiceBinding',
    metadata: {
      name: associationName(project.witName, binding.name),
      namespace: connection.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        [ASSOCIATION_WORKLOAD_LABEL]: project.witName,
      },
    },
    spec: {
      serviceName: binding.serviceName,
      bindingName: binding.name,
      capability: 'postgres',
      workloadName: project.witName,
    },
  }));
  const directory = join(project.projectRoot, '.di-framework', 'deploy');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'service-bindings.json');
  writeFileSync(path, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
  await runKubectl(deps, connection, ['apply', '-f', path], project.projectRoot);
  for (const binding of managed) {
    const name = associationName(project.witName, binding.name);
    let ready = false;
    let message = 'Waiting for provisioning';
    for (let attempt = 0; attempt < 90; attempt++) {
      const result = await captureKubectl(
        deps,
        connection,
        ['get', RESOURCE, name, '-o', 'json'],
        project.projectRoot,
      );
      if (result.exitCode !== 0) fail(`Cannot read ServiceBinding ${name}`);
      const association = JSON.parse(result.stdout) as Association;
      const condition = association.status?.conditions?.find((c) => c.type === 'Ready');
      message = condition?.message ?? message;
      if (
        !association.metadata.deletionTimestamp &&
        association.spec.serviceName === binding.serviceName &&
        association.status?.observedGeneration === association.metadata.generation &&
        association.status?.serviceRef?.uid === serviceUids.get(binding.name) &&
        condition?.status === 'True'
      ) {
        ready = true;
        break;
      }
      await deps.wait(2000);
    }
    if (!ready) fail(`ServiceBinding ${name} did not become ready: ${message}`);
  }
  return desired;
}

/** Called only after a successful rollout, or after workload deletion completes. */
export async function cleanupManagedBindings(
  project: WasmcloudProject,
  connection: ClusterConnection,
  desired: ReadonlySet<string>,
  deps: WasmcloudDeps,
): Promise<void> {
  const result = await captureKubectl(
    deps,
    connection,
    [
      'get',
      RESOURCE,
      '-l',
      `${ASSOCIATION_WORKLOAD_LABEL}=${project.witName},app.kubernetes.io/managed-by=di-framework`,
      '-o',
      'json',
      '--ignore-not-found',
    ],
    project.projectRoot,
  );
  if (result.exitCode !== 0) {
    if (
      /the server doesn't have a resource type|could not find the requested resource/i.test(
        result.stderr,
      )
    )
      return;
    fail('Cannot list obsolete deployment-owned ServiceBindings');
  }
  const items = result.stdout.trim()
    ? ((JSON.parse(result.stdout) as { items?: Association[] }).items ?? [])
    : [];
  for (const association of items) {
    if (desired.has(association.metadata.name)) continue;
    if (
      association.metadata.labels?.[ASSOCIATION_WORKLOAD_LABEL] !== project.witName ||
      association.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'di-framework'
    )
      continue;
    await runKubectl(
      deps,
      connection,
      [
        'delete',
        RESOURCE,
        association.metadata.name,
        '--ignore-not-found',
        '--wait=true',
        '--timeout=180s',
      ],
      project.projectRoot,
    );
  }
}
