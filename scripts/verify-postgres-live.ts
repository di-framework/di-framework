/** Opt-in integration check against an isolated, already installed local platform.
 * DI_POSTGRES_KUBECONFIG, DI_POSTGRES_REGISTRY_PUSH, DI_POSTGRES_REGISTRY_PULL,
 * DI_POSTGRES_HTTP are required. Uses tenant alpha (override DI_POSTGRES_TENANT).
 * The caller supplies port forwards when the cluster has no published endpoints.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildComponent } from '../packages/di-framework-cli-plugin-wasmcloud/src/build';
import { DEFAULT_DEPS } from '../packages/di-framework-cli-plugin-wasmcloud/src/deps';
import { loadProject } from '../packages/di-framework-cli-plugin-wasmcloud/src/project';
import { publishComponent } from '../packages/di-framework-cli-plugin-wasmcloud/src/publish';
import type { ClusterConnection } from '../packages/di-framework-cli-plugin-wasmcloud/src/target';
import {
  applyWorkload,
  deleteWorkload,
} from '../packages/di-framework-cli-plugin-wasmcloud/src/workload';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for an isolated validation cluster`);
  return value;
};
const tenant = process.env.DI_POSTGRES_TENANT ?? 'alpha';
const namespace = `di-tenant-${tenant}`;
const runtime = `di-runtime-${tenant}`;
const kubeconfig = required('DI_POSTGRES_KUBECONFIG');
const http = required('DI_POSTGRES_HTTP');
const connection: ClusterConnection = {
  target: 'validation',
  kubeconfig,
  namespace,
  hostgroup: `tenant-${tenant}`,
  registry: {
    push: required('DI_POSTGRES_REGISTRY_PUSH'),
    pull: required('DI_POSTGRES_REGISTRY_PULL'),
    insecure: true,
  },
};
const id = randomBytes(4).toString('hex');
const app = `pg-check-${id}`;
const retain = `pg-retain-${id}`;
const remove = `pg-delete-${id}`;
const root = mkdtempSync(join(tmpdir(), 'di-postgres-live-'));
const io = { stdout: process.stdout, stderr: process.stderr };
const kubectl = async (args: string[], ns = namespace) => {
  const result = await DEFAULT_DEPS.runCaptured(
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', ns, ...args],
    { cwd: root },
  );
  if (result.exitCode !== 0) throw new Error(`kubectl ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
const get = async (kind: string, name: string, ns = namespace) =>
  JSON.parse(await kubectl(['get', kind, name, '-o', 'json'], ns));
const apply = async (value: unknown) => {
  const path = join(root, 'resource.json');
  writeFileSync(path, JSON.stringify(value));
  await kubectl(['apply', '-f', path]);
};
const until = async (predicate: () => Promise<boolean>, message: string) => {
  for (let i = 0; i < 120; i++) {
    if (await predicate()) return;
    await DEFAULT_DEPS.wait(2000);
  }
  throw new Error(message);
};
const ready = (kind: string, name: string) =>
  until(
    async () =>
      (await get(kind, name)).status?.conditions?.some(
        (c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True',
      ),
    `${kind} ${name} did not become ready`,
  );
const list = async (kind: string, selector: string, ns = runtime) =>
  JSON.parse(await kubectl(['get', kind, '-l', selector, '-o', 'json'], ns)).items;
const absent = async (kind: string, name: string, ns = namespace) =>
  !(await kubectl(['get', kind, name, '--ignore-not-found', '-o', 'name'], ns)).trim();
const response = async (host: string, path = '/') => {
  const r = await fetch(http + path, {
    headers: { Host: host },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200);
  return r.json();
};
await ready('tenant', tenant);
for (const [name, policy] of [
  [retain, 'Retain'],
  [remove, 'Delete'],
])
  await apply({
    apiVersion: 'platform.di-framework.dev/v1alpha1',
    kind: 'BackingService',
    metadata: { name, namespace },
    spec: { type: 'postgres', deletionPolicy: policy },
  });
await ready('backingservice', retain);
await ready('backingservice', remove);
const serviceBefore = await get('backingservice', retain);
const retainSelector = `platform.di-framework.dev/owner-uid=${serviceBefore.metadata.uid}`;
const deleteSelector = `platform.di-framework.dev/owner-uid=${(await get('backingservice', remove)).metadata.uid}`;
const credentials = async (selector: string) =>
  (await list('secret', selector)).find((s: { metadata: { name: string } }) =>
    s.metadata.name.endsWith('-auth'),
  );
const originalCredentials = await credentials(retainSelector);
assert.ok(
  originalCredentials.data.APP_PASSWORD !== (await credentials(deleteSelector)).data.APP_PASSWORD,
);
assert.ok(originalCredentials.data.APP_PASSWORD !== originalCredentials.data.POSTGRES_PASSWORD);
console.log('PASS: separate volumes and application/admin credentials');

mkdirSync(join(root, 'src'));
mkdirSync(join(root, 'node_modules/@di-framework'), { recursive: true });
symlinkSync(
  resolve(import.meta.dir, '../packages/di-framework-wasmcloud'),
  join(root, 'node_modules/@di-framework/wasmcloud'),
  'dir',
);
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: app, version: '0.1.0', type: 'module' }),
);
writeFileSync(
  join(root, 'di-framework.config.json'),
  JSON.stringify({ name: app, entry: 'src/app.ts' }),
);
writeFileSync(
  join(root, 'src/bindings.ts'),
  `import {Postgres,WasmCloudBinding} from '@di-framework/wasmcloud';
@WasmCloudBinding('${retain}',{serviceName:'${retain}'}) export class First extends Postgres {}
@WasmCloudBinding('${remove}',{serviceName:'${remove}'}) export class Second extends Postgres {}`,
);
writeFileSync(
  join(root, 'src/app.ts'),
  `import {First,Second} from './bindings';
async function rows(db) { const [, stream, done] = await db.query('SELECT value FROM markers'); const rows=[]; for await(const row of stream) rows.push(row); await done; return rows; }
export default async function(req) { const first=new First(), second=new Second(); if(new URL(req.url).pathname==='/seed') { await first.queryBatch("CREATE TABLE markers(value text); INSERT INTO markers VALUES ('first');"); await second.queryBatch("CREATE TABLE markers(value text); INSERT INTO markers VALUES ('second');"); } return Response.json({first:await rows(first),second:await rows(second)}); }`,
);
const project = loadProject(root);
const built = await buildComponent(project, io, DEFAULT_DEPS);
const published = await publishComponent(
  project,
  connection,
  io,
  DEFAULT_DEPS,
  built.deploymentDigest,
);
await applyWorkload(project, connection, published.pullReference, io, DEFAULT_DEPS);
const expected = {
  first: [[{ tag: 'text', val: 'first' }]],
  second: [[{ tag: 'text', val: 'second' }]],
};
assert.deepEqual(await response(app, '/seed'), expected);
console.log('PASS: one wasmCloud application queries two isolated PostgreSQL services');

// Exercise the actual API server admission policy with the generated workload.
const manifestPath = join(root, '.di-framework/deploy/workload.yaml');
const sections = readFileSync(manifestPath, 'utf8')
  .split('\n---\n')
  .map((s) => Bun.YAML.parse(s));
const workload = sections.find((r: any) => r.kind === 'WorkloadDeployment') as any;
const host = workload.spec.template.spec.hostInterfaces.find((h: any) => h.package === 'postgres');
host.config = { url: 'postgresql://unmanaged.invalid/app' };
const bad = join(root, 'rejected.json');
writeFileSync(bad, JSON.stringify(workload));
const rejection = await DEFAULT_DEPS.runCaptured(
  'kubectl',
  ['--kubeconfig', kubeconfig, '-n', namespace, 'apply', '--dry-run=server', '-f', bad],
  { cwd: root },
);
assert.notEqual(rejection.exitCode, 0);
assert.match(rejection.stderr, /denied|not allowed/i);
console.log('PASS: admission rejects inline connection configuration');

const shared = { ...project, applicationName: `${app}-shared`, witName: `${app}-shared` };
await applyWorkload(shared, connection, published.pullReference, io, DEFAULT_DEPS);
assert.deepEqual(await response(shared.applicationName), expected);
await kubectl(['delete', 'pod', '-l', retainSelector, '--wait=true', '--timeout=120s'], runtime);
await ready('backingservice', retain);
await until(async () => {
  try {
    return JSON.stringify(await response(app)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}, 'Data did not persist after pod replacement');
assert.ok(
  JSON.stringify((await credentials(retainSelector)).data) ===
    JSON.stringify(originalCredentials.data),
);
console.log('PASS: credentials and rows persist after PostgreSQL pod replacement');

await kubectl(['delete', 'backingservice', retain, '--wait=false']);
await until(
  async () =>
    (await get('backingservice', retain)).status?.conditions?.some(
      (c: any) => c.reason === 'DeletionBlocked',
    ),
  'Deletion was not blocked',
);
assert.deepEqual(await response(app), expected);
const rejectedBinding = `${app}-late`;
await apply({
  apiVersion: 'platform.di-framework.dev/v1alpha1',
  kind: 'ServiceBinding',
  metadata: { name: rejectedBinding, namespace },
  spec: { serviceName: retain, bindingName: rejectedBinding, capability: 'postgres' },
});
await until(
  async () =>
    (await get('servicebinding', rejectedBinding)).status?.conditions?.some(
      (c: any) => c.status === 'False' && c.message.includes('deleting'),
    ),
  'New association was not refused',
);
await DEFAULT_DEPS.wait(3000);
assert.equal((await get('servicebinding', rejectedBinding)).status.conditions[0].status, 'False');
await kubectl(['delete', 'servicebinding', rejectedBinding, '--wait=true', '--timeout=120s']);
await deleteWorkload(project, connection, io, DEFAULT_DEPS);
assert.deepEqual(await response(shared.applicationName), expected);
assert.equal(
  (await list('secret', `platform.di-framework.dev/binding=${retain}`, namespace)).length,
  1,
);
console.log(
  'PASS: deletion preserves existing connections, refuses new bindings and retains shared projections',
);
await deleteWorkload(shared, connection, io, DEFAULT_DEPS);
await until(() => absent('backingservice', retain), 'Retain finalizer did not complete');
assert.equal((await list('pvc', retainSelector)).length, 1);
assert.ok(
  JSON.stringify((await credentials(retainSelector)).data) ===
    JSON.stringify(originalCredentials.data),
);
assert.equal((await list('deployment,service,configmap', retainSelector)).length, 0);
await kubectl(['delete', 'backingservice', remove, '--wait=false']);
await until(() => absent('backingservice', remove), 'Delete finalizer did not complete');
assert.equal((await list('pvc,secret,deployment,service,configmap', deleteSelector)).length, 0);
console.log('PASS: Retain preserves PVC/recovery credentials; Delete removes all owned resources');
await apply({
  apiVersion: 'platform.di-framework.dev/v1alpha1',
  kind: 'BackingService',
  metadata: { name: retain, namespace },
  spec: { type: 'postgres', deletionPolicy: 'Delete' },
});
await ready('backingservice', retain);
const replacement = await get('backingservice', retain);
assert.notEqual(replacement.metadata.uid, serviceBefore.metadata.uid);
assert.ok(
  (await credentials(`platform.di-framework.dev/owner-uid=${replacement.metadata.uid}`)).data
    .APP_PASSWORD !== originalCredentials.data.APP_PASSWORD,
);
await kubectl(['delete', 'backingservice', retain, '--wait=true', '--timeout=180s']);
await kubectl(
  ['delete', 'pvc,secret', '-l', retainSelector, '--wait=true', '--timeout=180s'],
  runtime,
);
console.log('PASS: recreation uses new storage/credentials; validation resources cleaned up');
