import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import {
  backingServiceResources,
  endpointFor,
  RUNTIME_DATA_NATS,
  resolveBackingSizing,
  resolveClass,
  tenantNameFromNamespace,
} from './backing-service-reconcile';
import {
  type BackingService,
  type BackingServiceClass,
  type Condition,
  type ControllerConfig,
  FINALIZER,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  resource,
  TENANT,
  type Tenant,
  tenantResources,
  type User,
  userResources,
  VERSION,
  validName,
} from './resources';

const plurals: Record<string, string> = {
  Namespace: 'namespaces',
  ServiceAccount: 'serviceaccounts',
  Secret: 'secrets',
  ConfigMap: 'configmaps',
  Service: 'services',
  ResourceQuota: 'resourcequotas',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  Deployment: 'deployments',
  Role: 'roles',
  RoleBinding: 'rolebindings',
  NetworkPolicy: 'networkpolicies',
  Tenant: 'tenants',
  User: 'users',
  Host: 'hosts',
  BackingServiceClass: 'backingserviceclasses',
  BackingService: 'backingservices',
  ServiceBinding: 'servicebindings',
};
export function collection(apiVersion: string, kind: string, namespace?: string): string {
  const plural = plurals[kind];
  if (!plural) throw new Error(`Unsupported resource kind: ${kind}`);
  return `${apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`}${namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''}/${plural}`;
}
type Owned = Tenant | User | BackingService;
function location(value: Resource | Owned): string {
  return `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${encodeURIComponent(value.metadata.name)}`;
}
export interface Api {
  call<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T>;
}
export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export class KubernetesApi implements Api {
  private readonly directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<T> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: process.env.KUBERNETES_SERVICE_HOST,
          port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443',
          path,
          method,
          // Trust the cluster CA and authenticate with the projected ServiceAccount token.
          // These fixed Kubernetes-mounted paths are never selected by tenant input.
          ca: readFileSync(`${this.directory}/ca.crt`),
          headers: {
            Authorization: `Bearer ${readFileSync(`${this.directory}/token`, 'utf8').trim()}`,
            'Content-Type': contentType,
            ...(data === undefined ? {} : { 'Content-Length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 300) {
              // Do not put API response bodies in logs: they may contain Secret data.
              reject(
                new ApiError(
                  res.statusCode ?? 500,
                  `${method} ${path.split('?')[0]} returned ${res.statusCode}`,
                ),
              );
            } else {
              try {
                resolve(text ? (JSON.parse(text) as T) : (undefined as T));
              } catch (error) {
                reject(error);
              }
            }
          });
        },
      );
      req.setTimeout(15_000, () => req.destroy(new Error('Kubernetes API request timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
}
export class Controller {
  constructor(
    private readonly api: Api,
    private readonly cfg: ControllerConfig,
  ) {}
  private async get<T>(path: string): Promise<T | undefined> {
    try {
      return await this.api.call<T>('GET', path);
    } catch (error) {
      if (error instanceof ApiError && error.code === 404) return undefined;
      throw error;
    }
  }
  private async list<T>(
    apiVersion: string,
    kind: string,
    labels: Record<string, string>,
  ): Promise<T[]> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const result = await this.api.call<{ items: T[] }>(
      'GET',
      `${collection(apiVersion, kind)}?labelSelector=${encodeURIComponent(selector)}`,
    );
    // Core Kubernetes list items may omit TypeMeta even though individual GETs include it.
    return result.items.map((item) => ({ ...item, apiVersion, kind }));
  }
  private async remove(value: Resource): Promise<void> {
    try {
      await this.api.call('DELETE', location(value), {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid: value.metadata.uid },
        propagationPolicy: 'Background',
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 404)) throw error;
    }
  }
  private async ensure(value: Resource, bootstrap = false): Promise<Resource> {
    const existing = await this.get<Resource>(location(value));
    const labels = existing?.metadata.labels;
    if (
      existing &&
      (labels?.[INSTALLATION] !== this.cfg.installation ||
        (labels?.[OWNER] !== value.metadata.labels?.[OWNER] &&
          !(bootstrap && !labels?.[OWNER] && labels?.[TENANT] === value.metadata.labels?.[TENANT])))
    ) {
      throw new Error(
        `Refusing to adopt ${value.kind} ${value.metadata.namespace ?? ''}/${value.metadata.name}`,
      );
    }
    if (
      existing &&
      value.kind === 'RoleBinding' &&
      JSON.stringify(existing.roleRef) !== JSON.stringify(value.roleRef)
    ) {
      // roleRef is immutable. Remove the previous grant before changing roles.
      await this.remove(existing);
    }
    return this.api.call<Resource>(
      'PATCH',
      `${location(value)}?fieldManager=di-platform-controller`,
      value,
      'application/apply-patch+yaml',
    );
  }
  private async finalizer(value: Owned, add: boolean): Promise<void> {
    const old = value.metadata.finalizers ?? [];
    const finalizers = add ? [...new Set([...old, FINALIZER])] : old.filter((f) => f !== FINALIZER);
    if (JSON.stringify(old) !== JSON.stringify(finalizers)) {
      const updated = await this.api.call<Owned>(
        'PATCH',
        location(value),
        { metadata: { resourceVersion: value.metadata.resourceVersion, finalizers } },
        'application/merge-patch+json',
      );
      value.metadata = updated.metadata;
    }
  }
  private async status(
    value: Owned,
    ready: boolean,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const old = value.status?.conditions?.find((c) => c.type === 'Ready');
    const condition: Condition = {
      type: 'Ready',
      status: ready ? 'True' : 'False',
      reason,
      message,
      observedGeneration: value.metadata.generation ?? 1,
      lastTransitionTime:
        old?.status === (ready ? 'True' : 'False')
          ? old.lastTransitionTime
          : new Date().toISOString(),
    };
    const status = {
      ...extra,
      observedGeneration: value.metadata.generation ?? 1,
      conditions: [condition],
    };
    if (JSON.stringify(value.status) === JSON.stringify(status)) return;
    await this.api.call(
      'PATCH',
      `${location(value)}/status`,
      { metadata: { resourceVersion: value.metadata.resourceVersion }, status },
      'application/merge-patch+json',
    );
    value.status = status;
  }
  private async revoke(labels: Record<string, string>): Promise<void> {
    for (const binding of await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
      [INSTALLATION]: this.cfg.installation,
      ...labels,
    }))
      await this.remove(binding);
  }
  async reconcileTenant(tenant: Tenant): Promise<void> {
    if (!validName(tenant.metadata.name)) throw new Error('Invalid tenant name');
    if (!tenant.metadata.deletionTimestamp) await this.finalizer(tenant, true);
    const n = names(tenant.metadata.name);
    if (tenant.spec.suspended || tenant.metadata.deletionTimestamp)
      await this.revoke({ [TENANT]: tenant.metadata.name });
    if (tenant.metadata.deletionTimestamp && tenant.spec.deletionPolicy === 'Delete') {
      let remaining = false;
      for (const name of [n.namespace, n.runtimeNamespace]) {
        const namespace = await this.get<Resource>(`${collection('v1', 'Namespace')}/${name}`);
        if (!namespace) continue;
        if (
          namespace.metadata.labels?.[OWNER] !== tenant.metadata.uid ||
          namespace.metadata.labels?.[INSTALLATION] !== this.cfg.installation
        )
          throw new Error(`Refusing to delete foreign namespace ${name}`);
        await this.remove(namespace);
        remaining = true;
      }
      if (!remaining) await this.finalizer(tenant, false);
      return;
    }
    if (tenant.metadata.deletionTimestamp) {
      let stopped = true;
      const deployments = await this.list<Resource>('apps/v1', 'Deployment', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: tenant.metadata.uid!,
      });
      for (const deployment of deployments) {
        const updated = await this.api.call<Resource>(
          'PATCH',
          `${location(deployment)}?fieldManager=di-platform-controller`,
          {
            metadata: { resourceVersion: deployment.metadata.resourceVersion },
            spec: { replicas: 0 },
          },
          'application/merge-patch+json',
        );
        const status = updated.status as
          | { observedGeneration?: number; replicas?: number }
          | undefined;
        stopped &&=
          status?.observedGeneration === updated.metadata.generation &&
          (status?.replicas ?? 0) === 0;
      }
      if (stopped) await this.finalizer(tenant, false);
      return;
    }
    for (const name of [n.namespace, n.runtimeNamespace]) {
      await this.ensure(
        resource(tenant, this.cfg.installation, 'v1', 'Namespace', name, undefined, {}),
        true,
      );
    }
    const secret = await this.get<{ data: Record<string, string> }>(
      `${collection('v1', 'Secret', this.cfg.namespace)}/wasmcloud-runtime-tls`,
    );
    const desired = tenantResources(tenant, this.cfg, secret);
    let ready = !!secret;
    for (const value of desired) {
      const applied = await this.ensure(value);
      if (value.kind === 'Deployment') {
        const spec = applied.spec as { replicas: number };
        const status = applied.status as
          | { observedGeneration?: number; readyReplicas?: number; replicas?: number }
          | undefined;
        ready &&=
          status?.observedGeneration === applied.metadata.generation &&
          (status?.readyReplicas ?? 0) === spec.replicas &&
          (spec.replicas !== 0 || (status?.replicas ?? 0) === 0);
      }
    }
    if (ready && !tenant.spec.suspended && !tenant.metadata.deletionTimestamp) {
      const hosts = await this.list<Resource>('runtime.wasmcloud.dev/v1alpha1', 'Host', {
        hostgroup: n.hostgroup,
      });
      ready =
        hosts.filter(
          (h) =>
            h.environment === n.namespace &&
            (h.status as { conditions?: Condition[] } | undefined)?.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ),
        ).length >= (tenant.spec.runtime?.replicas ?? 1);
    }
    await this.status(
      tenant,
      ready,
      tenant.spec.suspended ? 'Suspended' : ready ? 'Reconciled' : 'Provisioning',
      tenant.spec.suspended
        ? 'Access revoked; reconciling stopped runtime'
        : ready
          ? 'Tenant resources are ready'
          : 'Waiting for runtime and backend deployments',
      { ...n, httpService: `di-http.${n.runtimeNamespace}.svc.cluster.local` },
    );
  }
  async reconcileUser(user: User, tenants: Tenant[]): Promise<void> {
    if (!validName(user.metadata.name)) throw new Error('Invalid user name');
    if (!user.metadata.deletionTimestamp) await this.finalizer(user, true);
    const desired = userResources(user, tenants, this.cfg);
    const bindings = await this.list<Resource>('rbac.authorization.k8s.io/v1', 'RoleBinding', {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: user.metadata.uid!,
    });
    for (const binding of bindings)
      if (!desired.some((r) => location(r) === location(binding))) await this.remove(binding);
    const accounts = await this.list<Resource>('v1', 'ServiceAccount', {
      [INSTALLATION]: this.cfg.installation,
      [OWNER]: user.metadata.uid!,
    });
    for (const account of accounts)
      if (!desired.some((r) => location(r) === location(account))) await this.remove(account);
    for (const value of desired) await this.ensure(value);
    if (user.metadata.deletionTimestamp) {
      await this.finalizer(user, false);
      return;
    }
    const complete =
      user.spec.suspended ||
      desired.filter((r) => r.kind === 'RoleBinding').length === user.spec.memberships.length * 2;
    await this.status(
      user,
      !!complete,
      user.spec.suspended ? 'Suspended' : complete ? 'Reconciled' : 'TenantNotReady',
      user.spec.suspended
        ? 'Access revoked and ServiceAccount removed'
        : complete
          ? 'Memberships reconciled'
          : 'Waiting for every referenced tenant to be ready',
      user.spec.suspended
        ? { serviceAccount: null }
        : {
            serviceAccount: {
              name: `di-user-${user.metadata.name}`,
              namespace: this.cfg.namespace,
            },
          },
    );
  }
  /**
   * Provision independent Redis/NATS instances for a BackingService CR.
   * Never touches runtime-internal `${RUNTIME_DATA_NATS}` (hostgroup data plane).
   */
  async reconcileBackingService(
    service: BackingService,
    tenant: Tenant,
    classes: BackingServiceClass[],
  ): Promise<void> {
    if (!validName(service.metadata.name)) throw new Error('Invalid BackingService name');
    if (!service.metadata.uid) throw new Error('BackingService is missing metadata.uid');
    const n = names(tenant.metadata.name);
    if (service.metadata.namespace !== n.namespace)
      throw new Error(
        `BackingService ${service.metadata.name} must live in tenant namespace ${n.namespace}`,
      );
    if (!service.metadata.deletionTimestamp) await this.finalizer(service, true);

    if (service.metadata.deletionTimestamp) {
      const owned = await this.list<Resource>('apps/v1', 'Deployment', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: service.metadata.uid,
      });
      const secrets = await this.list<Resource>('v1', 'Secret', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: service.metadata.uid,
      });
      const services = await this.list<Resource>('v1', 'Service', {
        [INSTALLATION]: this.cfg.installation,
        [OWNER]: service.metadata.uid,
      });
      if (service.spec.deletionPolicy === 'Delete') {
        for (const value of [...owned, ...secrets, ...services]) await this.remove(value);
        await this.finalizer(service, false);
        return;
      }
      // Retain: scale down and release finalizer; hostPath data kept (#453 expands this).
      let stopped = true;
      for (const deployment of owned) {
        // Never scale/delete runtime-internal data NATS via BS ownership (wrong owner).
        if (deployment.metadata.name === RUNTIME_DATA_NATS) {
          throw new Error(`Refusing to manage runtime data plane ${RUNTIME_DATA_NATS}`);
        }
        const updated = await this.api.call<Resource>(
          'PATCH',
          `${location(deployment)}?fieldManager=di-platform-controller`,
          {
            metadata: { resourceVersion: deployment.metadata.resourceVersion },
            spec: { replicas: 0 },
          },
          'application/merge-patch+json',
        );
        const status = updated.status as
          | { observedGeneration?: number; replicas?: number }
          | undefined;
        stopped &&=
          status?.observedGeneration === updated.metadata.generation &&
          (status?.replicas ?? 0) === 0;
      }
      await this.status(
        service,
        false,
        'Deleting',
        'Stopping backing service workloads',
        { runtimeNamespace: n.runtimeNamespace },
      );
      if (stopped) await this.finalizer(service, false);
      return;
    }

    const resolved = resolveClass(service, classes, tenant.metadata.name);
    if ('error' in resolved) {
      await this.status(service, false, 'Failed', resolved.error, {
        runtimeNamespace: n.runtimeNamespace,
      });
      return;
    }
    const { cls } = resolved;
    const sized = resolveBackingSizing(service, cls, tenant);
    if ('error' in sized) {
      await this.status(service, false, 'Failed', sized.error, {
        runtimeNamespace: n.runtimeNamespace,
        classRef: {
          name: cls.metadata.name,
          uid: cls.metadata.uid,
          generation: cls.metadata.generation,
        },
      });
      return;
    }

    const classRef = {
      name: cls.metadata.name,
      uid: cls.metadata.uid,
      generation: cls.metadata.generation,
    };
    const endpoint = endpointFor(service, tenant, cls.spec.provider);
    const statusExtra = {
      runtimeNamespace: n.runtimeNamespace,
      classRef,
      endpoint,
    };

    const desired = backingServiceResources(service, tenant, cls, this.cfg, sized.sizing);
    let ready = true;
    for (const value of desired) {
      const applied = await this.ensure(value);
      if (value.kind === 'Deployment') {
        if (applied.metadata.name === RUNTIME_DATA_NATS)
          throw new Error(`Refusing to manage runtime data plane ${RUNTIME_DATA_NATS}`);
        const spec = applied.spec as { replicas: number };
        const status = applied.status as
          | { observedGeneration?: number; readyReplicas?: number; replicas?: number }
          | undefined;
        ready &&=
          status?.observedGeneration === applied.metadata.generation &&
          (status?.readyReplicas ?? 0) === spec.replicas &&
          (spec.replicas !== 0 || (status?.replicas ?? 0) === 0);
      }
    }
    await this.status(
      service,
      ready && !tenant.spec.suspended,
      tenant.spec.suspended ? 'Suspended' : ready ? 'Ready' : 'Provisioning',
      tenant.spec.suspended
        ? 'Tenant suspended; backing service scaled down'
        : ready
          ? 'Backing service deployment is ready'
          : 'Waiting for backing service deployment',
      statusExtra,
    );
  }
  async tick(): Promise<void> {
    const tenants = await this.list<Tenant>(VERSION, 'Tenant', {
      [INSTALLATION]: this.cfg.installation,
    });
    const users = await this.list<User>(VERSION, 'User', { [INSTALLATION]: this.cfg.installation });
    const classes = await this.list<BackingServiceClass>(VERSION, 'BackingServiceClass', {
      [INSTALLATION]: this.cfg.installation,
    });
    // Cluster-wide list: BackingServices are namespaced under di-tenant-* and may lack
    // installation labels until the controller owns their infra.
    const services = await this.list<BackingService>(VERSION, 'BackingService', {});
    const tenantByName = new Map(tenants.map((t) => [t.metadata.name, t]));
    for (const value of [...tenants, ...users]) {
      try {
        if (value.kind === 'Tenant') await this.reconcileTenant(value as Tenant);
        else await this.reconcileUser(value as User, tenants);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Reconciliation failed';
        console.error(`${value.kind}/${value.metadata.name}: ${message}`);
        try {
          await this.status(value, false, 'ReconcileError', message);
        } catch {
          /* Retry on the next poll, including resourceVersion conflicts. */
        }
      }
    }
    for (const service of services) {
      const tenantName = tenantNameFromNamespace(service.metadata.namespace);
      const tenant = tenantName ? tenantByName.get(tenantName) : undefined;
      if (!tenant) continue;
      try {
        await this.reconcileBackingService(service, tenant, classes);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Reconciliation failed';
        console.error(
          `BackingService/${service.metadata.namespace}/${service.metadata.name}: ${message}`,
        );
        try {
          await this.status(service, false, 'Failed', message, {
            runtimeNamespace: names(tenant.metadata.name).runtimeNamespace,
          });
        } catch {
          /* Retry on the next poll. */
        }
      }
    }
  }
}
export async function main(
  api: Api = new KubernetesApi(),
  pause: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> {
  const cfg = JSON.parse(process.env.PLATFORM_CONFIG ?? '{}') as ControllerConfig;
  if (!cfg.installation || !cfg.namespace || !cfg.hostImage || !cfg.schedulerNatsUrl)
    throw new Error('Missing PLATFORM_CONFIG');
  const controller = new Controller(api, cfg);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGTERM', stop);
  try {
    while (!stopped) {
      try {
        await controller.tick();
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'API unavailable');
      }
      if (!stopped) await pause(3_000);
    }
  } finally {
    process.off('SIGTERM', stop);
  }
}
export function reportFatal(
  error: Error,
  status: { exitCode?: string | number | null } = process,
): void {
  console.error(error.message);
  status.exitCode = 1;
}
if (require.main === module) main().catch(reportFatal);
