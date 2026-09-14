import { describe, expect, it } from 'bun:test';
import { hostStoragePath, isWorkloadReady, workloadDocuments } from '../src/documents';
import { type DeployIntent, ORG_LABEL, OWNER_LABEL, TEAM_LABEL } from '../src/intent';

const intent: DeployIntent = {
  application: 'warehouse-take',
  witName: 'warehouse-take',
  image: `registry.example.com/take@sha256:${'a'.repeat(64)}`,
  deploymentDigest: 'abc',
  ingress: true,
  worker: false,
  bindings: [],
  hasActors: false,
  persistentStorage: false,
  cronJobs: [],
  queueHandlers: [],
};

describe('workloadDocuments', () => {
  it('stamps org, team, and owner from the principal, not the client', () => {
    const documents = workloadDocuments(
      intent,
      { namespace: 'wasmcloud' },
      { org: 'acme', team: 'warehouse', owner: 'alice' },
      'token',
    );
    const wd = documents.find((document) => document.kind === 'WorkloadDeployment');
    expect(wd?.metadata.namespace).toBe('wasmcloud');
    expect(wd?.metadata.labels[ORG_LABEL]).toBe('acme');
    expect(wd?.metadata.labels[TEAM_LABEL]).toBe('warehouse');
    expect(wd?.metadata.labels[OWNER_LABEL]).toBe('alice');
    expect(JSON.stringify(wd)).toContain(`registry.example.com/take@sha256:${'a'.repeat(64)}`);
    expect(JSON.stringify(wd)).not.toContain('hostPath');
  });

  it('uses the server namespace even when the application name looks like a path', () => {
    const documents = workloadDocuments(
      intent,
      { namespace: 'platform' },
      { org: 'acme', owner: 'alice' },
    );
    expect(documents.every((document) => document.metadata.namespace === 'platform')).toBe(true);
    expect(hostStoragePath('warehouse-take')).toBe('/var/lib/di-framework/storage/warehouse-take');
  });
});

it('renders storage, queue limits, cron control and merged host interfaces', () => {
  const documents = workloadDocuments(
    {
      ...intent,
      ingress: false,
      persistentStorage: true,
      allowedIpNameLookups: ['example.test'],
      queueHandlers: [
        {
          className: 'Jobs',
          methodName: 'run',
          queueName: 'email-out',
          options: { concurrency: 2, maxRetries: 3, backoffMs: 100, timeoutMs: 1000 },
        },
      ],
      cronJobs: [
        {
          jobId: 'daily',
          kebabId: '',
          className: 'Jobs',
          methodName: 'run',
          cronExpression: '* * * * *',
          allowConcurrent: false,
        },
      ],
      bindings: [
        {
          className: 'Http',
          name: 'http',
          kind: 'OutgoingHttp',
          package: 'wasi:http',
          version: '0.3.0',
          interfaces: ['client', 'handler'],
          config: { allowedHosts: 'example.test' },
          configFrom: 'http-config',
          secretFrom: 'http-secret',
        },
        {
          className: 'Config',
          name: 'config',
          kind: 'Config',
          package: 'wasi:config',
          version: '0.2.0',
          interfaces: ['store'],
          configFrom: 'config',
          secretFrom: 'secret',
        },
        {
          className: 'Kv',
          name: 'kv',
          kind: 'Keyvalue',
          package: 'wasmcloud:keyvalue',
          version: '0.2.0',
          interfaces: ['types', 'store'],
        },
        {
          className: 'Empty',
          name: 'empty',
          kind: 'Keyvalue',
          package: 'wasmcloud:keyvalue',
          version: '0.2.0',
          interfaces: ['types'],
        },
        {
          className: 'Custom',
          name: 'custom',
          kind: 'Custom',
          package: 'custom',
          version: '1.0.0',
          interfaces: ['custom'],
        },
      ],
    },
    { namespace: 'platform' },
    { org: 'acme', owner: 'alice' },
    'secret-token',
  );
  const wd = documents.find((doc) => doc.kind === 'WorkloadDeployment');
  expect(wd).toMatchObject({
    spec: {
      deployPolicy: 'Recreate',
      template: {
        spec: {
          hostSelector: { hostgroup: 'storage' },
          volumes: [
            {
              name: 'app-storage',
              hostPath: { path: '/var/lib/di-framework/storage/warehouse-take' },
            },
          ],
          components: [
            {
              localResources: {
                allowedIpNameLookups: ['example.test'],
                environment: {
                  config: {
                    DI_QUEUE_EMAIL_OUT_CONCURRENCY: '2',
                    DI_QUEUE_EMAIL_OUT_MAX_RETRIES: '3',
                    DI_QUEUE_EMAIL_OUT_BACKOFF_MS: '100',
                    DI_QUEUE_EMAIL_OUT_TIMEOUT_MS: '1000',
                    DI_CRON_MODE: 'external',
                    QUEUE_DB_PATH: '/data/queue.db',
                    MIGRATION_DB_PATH: '/data/migrations.db',
                  },
                },
              },
              hostInterfaces: [
                {
                  namespace: 'wasi',
                  package: 'http',
                  interfaces: ['handler'],
                  config: {
                    host: 'warehouse-take.platform.svc.cluster.local',
                    allowedHosts: 'example.test',
                  },
                  configFrom: [{ name: 'http-config' }],
                  secretFrom: [{ name: 'http-secret' }],
                },
                { namespace: 'wasi', package: 'config' },
                { namespace: 'wasmcloud', package: 'keyvalue', interfaces: ['store'] },
                { namespace: 'wasi', package: 'custom' },
              ],
            },
          ],
        },
      },
    },
  });
  const cron = documents.find((doc) => doc.kind === 'CronJob');
  expect(cron).toMatchObject({
    metadata: { name: 'warehouse-take-jobs-run' },
    spec: { concurrencyPolicy: 'Forbid', schedule: '* * * * *' },
  });
  expect(JSON.stringify(cron)).toContain('/_di/cron/daily/invoke');
  expect(JSON.stringify(cron)).toContain('secretKeyRef');
  expect(JSON.stringify(documents)).toContain('secret-token');
});

it('mounts actor state separately and supports workers without public ingress', () => {
  const docs = workloadDocuments(
    { ...intent, hasActors: true, worker: true },
    { namespace: 'platform' },
    { org: 'acme', owner: 'alice' },
  );
  expect(JSON.stringify(docs)).toContain('ACTOR_STORAGE_DIR');
  expect(JSON.stringify(docs)).toContain('/data/actors');
  expect(JSON.stringify(docs)).not.toContain('QUEUE_DB_PATH');
});

it('recognizes supported readiness status shapes', () => {
  expect(isWorkloadReady({})).toBe(false);
  expect(isWorkloadReady({ spec: { replicas: 2 }, status: { readyReplicas: 1 } })).toBe(false);
  expect(isWorkloadReady({ status: { replicas: { ready: 1 } } })).toBe(true);
  expect(isWorkloadReady({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })).toBe(
    true,
  );
  expect(isWorkloadReady({ status: { conditions: [{ type: 'Available', status: 'True' }] } })).toBe(
    true,
  );
  expect(isWorkloadReady({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toBe(
    false,
  );
});
