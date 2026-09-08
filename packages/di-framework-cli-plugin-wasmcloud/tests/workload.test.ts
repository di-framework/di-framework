import { describe, expect, it } from 'bun:test';
import { loadProject } from '../src/project';
import {
  applyWorkload,
  renderWorkloadManifest,
  WORKLOAD_DEPLOYMENT_RESOURCE,
  WORKLOAD_REPLICA_SET_RESOURCE,
  waitForReady,
} from '../src/workload';
import { captureIo, fakeDeps, makeWorkspace, type RunnerInvocation } from './helpers';

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
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: WorkloadDeployment');
    expect(yaml).toContain('name: greeter');
    expect(yaml).toContain('registry.example.com/team/greeter:sha256-abc');
    expect(yaml).toContain('hostInterfaces:');
    expect(yaml).toContain('package: http');
    expect(yaml).toContain('version: "0.3.0"');
    expect(yaml).toContain('- handler');
    expect(yaml).toContain('"host": "greeter"');
    expect(yaml).not.toContain('incoming-handler');
    expect(yaml).not.toContain('Pulumi');
  });

  it('renders named hostInterfaces with secretFrom from binding records', () => {
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
    expect(yaml).toContain('name: "user-database"');
    expect(yaml).toContain('package: postgres');
    expect(yaml).toContain('version: "0.2.0"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: "orders-user-database"');
  });

  it('treats unparseable kubectl output as not ready and times out', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    await expect(
      waitForReady(
        project,
        {
          target: 'development',
          kubeconfig: '/tmp/kube',
          namespace: 'wasmcloud',
          registry: REGISTRY,
        },
        fakeDeps({
          cwd: greeter,
          capturedStdout: { 'kubectl get': 'not-json' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOYMENT_NOT_READY', exitCode: 3 });
  });

  it('accepts the Available condition when readyReplicas is absent', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    await waitForReady(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({
            status: { conditions: [{ type: 'Available', status: 'True' }] },
          }),
        },
      }),
    );
  });

  it('accepts the runtime operator Ready condition', async () => {
    const { greeter } = makeWorkspace();
    await waitForReady(
      loadProject(greeter),
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          }),
        },
      }),
    );
  });

  it('accepts legacy readyReplicas without readiness conditions', async () => {
    const { greeter } = makeWorkspace();
    await waitForReady(
      loadProject(greeter),
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({ spec: { replicas: 2 }, status: { readyReplicas: 2 } }),
        },
      }),
    );
  });

  it('times out with WASMCLOUD_DEPLOYMENT_NOT_READY when the workload never becomes ready', async () => {
    const { greeter } = makeWorkspace();
    const output = captureIo();
    const invocations: RunnerInvocation[] = [];
    const project = loadProject(greeter);
    await expect(
      waitForReady(
        project,
        {
          target: 'development',
          kubeconfig: '/tmp/kube',
          namespace: 'wasmcloud',
          registry: REGISTRY,
        },
        fakeDeps({
          cwd: greeter,
          invocations,
          capturedStdout: { 'kubectl get': '{}' },
        }),
        output.io,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOYMENT_NOT_READY', exitCode: 3 });
    expect(output.stderr.join('')).toContain('WorkloadDeployment');
    expect(output.stderr.join('')).toContain('WorkloadReplicaSets');
    expect(
      invocations.some((invocation) => invocation.args.includes(WORKLOAD_REPLICA_SET_RESOURCE)),
    ).toBe(true);
    expect(invocations.some((invocation) => invocation.args.includes('logs'))).toBe(true);
  });

  it('applies the generated manifest through kubectl', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const invocations: RunnerInvocation[] = [];
    const path = await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations }),
    );
    expect(path).toContain('.di-framework');
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('get') &&
          invocation.args.includes(WORKLOAD_DEPLOYMENT_RESOURCE),
      ),
    ).toBe(true);
  });
});
