import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project';
import { applyWorkload, isReady, renderWorkloadManifest, waitForReady } from '../src/workload';
import {
  captureIo,
  fakeDeps,
  makeWorkspace,
  type RunnerInvocation,
} from './helpers';

const REGISTRY = {
  push: 'registry.example.com/team',
  pull: 'registry.example.com/team',
  insecure: false,
};

describe('workload manifests', () => {
  it('renders Service and WorkloadDeployment from the project name and image', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
    );
    expect(yaml).not.toContain('allowedIpNameLookups');
    const permitted = renderWorkloadManifest(
      { ...project, allowedIpNameLookups: ['echo.example.com'] },
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/probe:local',
    );
    expect(permitted).toContain('allowedIpNameLookups: ["echo.example.com"]');
    expect(permitted).toContain('localResources:');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: WorkloadDeployment');
    expect(yaml).toContain('name: greeter');
    expect(yaml).toContain('registry.example.com/team/greeter:sha256-abc');
    expect(yaml).toContain('hostInterfaces:');
    expect(yaml).toContain('package: http');
    expect(yaml).toContain('version: "0.3.0"');
    expect(yaml).toContain('- handler');
    expect(yaml).toContain('"host": "greeter"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
    expect(yaml).not.toContain('incoming-handler');
    expect(yaml).not.toContain('Pulumi');
  });

  it('renders an unlabeled PostgreSQL host interface with its binding secretFrom', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
      [
        {
          package: 'wasi:http',
          version: '0.3.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'http-adapter',
        },
        {
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          direction: 'import',
          instanceName: 'user-database',
          source: 'UserDatabase',
        },
      ],
      [
        {
          className: 'UserDatabase',
          name: 'user-database',
          kind: 'Postgres',
          requirement: {
            package: 'wasmcloud:postgres',
            version: '0.2.0',
            interfaces: ['query', 'prepared', 'types'],
            direction: 'import',
            instanceName: 'user-database',
            source: 'UserDatabase',
          },
          secretFrom: 'orders-user-database',
        },
      ],
    );
    expect(yaml).not.toContain('name: "user-database"');
    expect(yaml).toContain('package: postgres');
    expect(yaml).toContain('version: "0.2.0"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: "orders-user-database"');
  });

  it('treats unparseable status JSON as not ready', () => {
    expect(isReady('not-json')).toBe(false);
  });

  it('accepts Available, Ready, and readyReplicas status shapes', () => {
    expect(
      isReady(JSON.stringify({ status: { conditions: [{ type: 'Available', status: 'True' }] } })),
    ).toBe(true);
    expect(
      isReady(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })),
    ).toBe(true);
    expect(isReady(JSON.stringify({ spec: { replicas: 2 }, status: { readyReplicas: 2 } }))).toBe(
      true,
    );
  });

  it('times out with WASMCLOUD_DEPLOYMENT_NOT_READY when the controller never reports ready', async () => {
    const { greeter } = makeWorkspace();
    const output = captureIo();
    await expect(
      waitForReady(
        loadProject(greeter),
        {
          target: 'development',
          namespace: 'wasmcloud',
          registry: REGISTRY,
          controller: { url: 'https://deploy.example.test', host: 'deploy' },
        },
        fakeDeps({
          cwd: greeter,
          fetch: async () => new Response(JSON.stringify({ ready: false }), { status: 200 }),
        }),
        output.io,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOYMENT_NOT_READY', exitCode: 3 });
    expect(output.stderr.join('')).toContain('WorkloadDeployment');
  });

  it('renders control secrets, storage mounts, and injected control HTTP exports', () => {
    const { greeter } = makeWorkspace();
    const project = { ...loadProject(greeter), ingress: false, applicationType: 'worker' as const };
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:local',
      [],
      [],
      {
        controlSecretName: 'greeter-control',
        hasPersistentStorage: true,
        environment: { EXTRA: '1' },
      },
      [],
      [
        {
          className: 'Worker',
          methodName: 'run',
          queueName: 'jobs',
          filePath: 'src/worker.ts',
          options: {},
        },
      ],
    );
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
    expect(yaml).toContain('EXTRA: "1"');
    expect(yaml).toContain('volumeMounts:');
    expect(yaml).toContain('hostgroup: storage');
    expect(yaml).toContain('package: http');
    expect(yaml).toContain('"host": "greeter.wasmcloud.svc.cluster.local"');
    expect(yaml).toContain('DI_CONTROL_REJECT_FORWARDED: "1"');
    expect(yaml).toContain('DI_CONTROL_HTTP_HOST: "greeter,greeter.wasmcloud.svc.cluster.local"');
  });

  it('applyWorkload posts intent to the controller and never invokes kubectl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-apply-queue-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'worker.ts'),
      `
import { QueueHandler } from '@di-framework/queues';
export class Worker {
  @QueueHandler('jobs')
  async run() {}
}
`,
    );
    writeFileSync(join(root, 'src', 'index.ts'), 'export * from "./worker";');
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Queue App', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
    );
    writeFileSync(join(root, 'package.json'), '{ "name": "queue-app", "version": "1.0.0" }\n');
    const project = loadProject(root);
    const invocations: RunnerInvocation[] = [];
    const connection = {
      target: 'development',
      namespace: 'wasmcloud',
      registry: REGISTRY,
      controller: { url: 'https://deploy.example.test', host: 'deploy' as const },
    };
    const path = await applyWorkload(
      project,
      connection,
      'registry.example.com/team/queue-app:sha256-abc',
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );
    expect(path).toContain('workload.yaml');
    expect(invocations.some((entry) => entry.command === 'kubectl')).toBe(false);
  });

  it('maps controller storage conflicts', async () => {
    const { greeter } = makeWorkspace();
    await expect(
      applyWorkload(
        loadProject(greeter),
        {
          target: 'development',
          namespace: 'wasmcloud',
          registry: REGISTRY,
          controller: { url: 'https://deploy.example.test', host: 'deploy' },
        },
        'registry.example.com/team/greeter:sha256-abc',
        captureIo().io,
        fakeDeps({
          cwd: greeter,
          fetch: async () =>
            new Response(JSON.stringify({ error: 'storage-conflict' }), { status: 409 }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT', exitCode: 2 });
  });

  it('creates localResources for control secrets and allowed IP lookups when no env is configured', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      { ...project, allowedIpNameLookups: ['lookup.example.com'] },
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:lookup',
    );
    expect(yaml).toContain('allowedIpNameLookups: ["lookup.example.com"]');
    expect(yaml).toContain('localResources:');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
  });

  it('applies through the controller HTTP API', async () => {
    const { greeter } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const posted: string[] = [];
    const path = await applyWorkload(
      loadProject(greeter),
      {
        target: 'development',
        namespace: 'wasmcloud',
        registry: REGISTRY,
        controller: { url: 'https://deploy.example.test', host: 'deploy' },
      },
      'registry.example.com/team/greeter:sha256-abc',
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        invocations,
        fetch: async (input, init) => {
          if (init?.body !== undefined) posted.push(String(init.body));
          return new Response(JSON.stringify({ ready: true, namespace: 'wasmcloud' }), {
            status: 200,
          });
        },
      }),
    );
    expect(path).toContain('.di-framework');
    expect(invocations.some((invocation) => invocation.command === 'kubectl')).toBe(false);
    expect(posted.some((body) => body.includes('"application":"greeter"'))).toBe(true);
  });
});
