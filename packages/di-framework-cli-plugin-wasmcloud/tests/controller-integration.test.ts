import { expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { storeCredential } from '../src/credentials';
import { runWasmcloudDeploy } from '../src/deploy';
import { runWasmcloudDoctor } from '../src/doctor';
import { parseDeployManifest } from '../src/manifest';
import { loadPlatformOutputs } from '../src/platform';
import { loadProject } from '../src/project';
import { renderWorkloadManifest } from '../src/workload';
import { captureIo, fakeDeps, makeWorkspace, platformOutputJson } from './helpers';

it.each(['healthy', 'unhealthy', 'invalid'])(
  'diagnoses controller and login (%s)',
  async (mode) => {
    const { root, greeter, kubeconfig } = makeWorkspace();
    const path = join(root, 'credentials.json');
    if (mode === 'healthy')
      storeCredential(path, 'local', {
        accessToken: 'saved',
        controller: { url: 'https://deploy.test', host: 'deploy' },
      });
    const result = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        credentialsPath: path,
        env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' },
        capturedStdout: {
          'pulumi stack output': mode === 'invalid' ? '{}' : platformOutputJson(kubeconfig),
        },
        fetch: async () => new Response('', { status: mode === 'healthy' ? 200 : 503 }),
      }),
    );
    const checks = (result.data as { checks: Array<{ name: string; ok: boolean }> }).checks;
    expect(checks.find((check) => check.name === 'login')?.ok).toBe(mode === 'healthy');
    expect(checks.find((check) => check.name === 'controller')?.ok).toBe(mode === 'healthy');
  },
);

it('rejects incomplete external targets and parses all supported controller outputs', async () => {
  expect(() =>
    parseDeployManifest('/tmp/deploy.toml', '[targets.dev]\ncontroller="https://deploy.test"', {}),
  ).toThrow(/Missing: registry/);
  const { root, kubeconfig } = makeWorkspace();
  const outputs = JSON.parse(platformOutputJson(kubeconfig));
  for (const [controller, expected] of [
    ['https://deploy.test', { url: 'https://deploy.test', host: 'deploy' }],
    [
      { http: 'https://deploy.test', host: 'custom' },
      { url: 'https://deploy.test', host: 'custom' },
    ],
  ] as const) {
    const deps = fakeDeps({
      cwd: root,
      capturedStdout: { 'pulumi stack output': JSON.stringify({ ...outputs, controller }) },
    });
    expect((await loadPlatformOutputs(deps, root, 'dev', 'local')).controller).toEqual(expected);
  }
  for (const controller of [42, {}, { url: '' }]) {
    const deps = fakeDeps({
      cwd: root,
      capturedStdout: { 'pulumi stack output': JSON.stringify({ ...outputs, controller }) },
    });
    await expect(loadPlatformOutputs(deps, root, 'dev', 'local')).rejects.toThrow(/controller/);
  }
});

it('submits discovered bindings in the controller intent', async () => {
  const { greeter } = makeWorkspace();
  writeFileSync(
    join(greeter, 'src/bindings.ts'),
    `import { Postgres, WasmCloudBinding } from '@di-framework/wasmcloud';
@WasmCloudBinding('db', { secretFrom: 'db-secret', configFrom: 'db-config', config: { database: 'app' } })
export class Database extends Postgres {}
`,
  );
  let submitted: Record<string, unknown> | undefined;
  await runWasmcloudDeploy(
    ['--target', 'development'],
    captureIo().io,
    fakeDeps({
      cwd: greeter,
      resolutions: {
        '@di-framework/wasmcloud/catalog.json': resolve(
          import.meta.dir,
          '../../di-framework-wasmcloud/catalog.json',
        ),
      },
      fetch: async (_input, init) => {
        if (init?.method === 'POST') submitted = JSON.parse(String(init.body));
        return Response.json({ ready: true });
      },
    }),
  );
  expect(submitted?.bindings).toMatchObject([
    {
      className: 'Database',
      name: 'db',
      kind: 'Postgres',
      package: 'wasmcloud:postgres',
      secretFrom: 'db-secret',
      configFrom: 'db-config',
      config: { database: 'app' },
    },
  ]);
  expect(submitted?.image).toMatch(/@sha256:[a-f0-9]{64}$/);
});

it('renders DNS lookups for a component without HTTP or storage', () => {
  const { greeter } = makeWorkspace();
  const path = join(greeter, 'di-framework.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf8')),
      ingress: false,
      allowedIpNameLookups: ['example.test'],
    }),
  );
  const manifest = renderWorkloadManifest(
    loadProject(greeter),
    { target: 'dev', namespace: 'platform', registry: { push: 'r', pull: 'r', insecure: false } },
    `r/app@sha256:${'a'.repeat(64)}`,
    [],
    [],
  );
  expect(manifest).toContain('localResources:');
  expect(manifest).toContain('allowedIpNameLookups: ["example.test"]');
  expect(manifest).not.toContain('kind: Service');
});
