import { describe, expect, it } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildComponent, requirementsForProject } from '../src/build';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import { loadProject } from '../src/project';
import { writeWorkloadManifest } from '../src/workload-members';
import { captureIo, fakeDeps, makeAssets, makeProject } from './helpers';

function member(name: string, declaration: string) {
  const root = makeProject({ name, entry: 'src/app.ts', workload: 'warehouse' });
  writeFileSync(
    join(root, 'src/app.ts'),
    `import { WorkloadComponent, WorkloadService } from '@di-framework/wasmcloud';\n${declaration}\n`,
  );
  return loadProject(root);
}

describe('implicit workloads', () => {
  it('derives membership and routes without executing members', () => {
    const take = member(
      'take',
      "export const fetch = WorkloadComponent({ path: '/take' })(() => { throw new Error('do not execute'); });",
    );
    const receive = member(
      'receive',
      "export const fetch = WorkloadComponent({ path: '/receive' })(() => {});",
    );
    const sync = member(
      'sync',
      "export const onMessage = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(async () => {});",
    );
    expect(sync.ingress).toBe(false);
    expect(take.ingress).toBe(true);
    const path = writeWorkloadManifest(take.projectRoot, 'warehouse', [take, sync, receive]);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    expect(manifest.name).toBe('warehouse');
    expect(manifest.paths).toEqual({ '/receive': 'receive', '/sync': 'sync', '/take': 'take' });
    expect(manifest.routes).toEqual({ '/receive': 'receive', '/take': 'take' });
    expect(manifest.members.map((p: { name: string }) => p.name)).toEqual([
      'receive',
      'sync',
      'take',
    ]);
    expect(manifest.members[1]).toMatchObject({
      kind: 'service',
      path: '/sync',
      exportName: 'onMessage',
      subscriptions: ['warehouse.stock'],
    });
  });

  it('rejects ambiguous route claims and conflicting source membership', () => {
    const a = member('a', "export const fetch = WorkloadComponent({ path: '/take' })(() => {});");
    const b = member('b', "export const fetch = WorkloadComponent({ path: '/take' })(() => {});");
    expect(() => writeWorkloadManifest(a.projectRoot, 'warehouse', [a, b])).toThrow(
      'both claim /take',
    );
    expect(() =>
      member(
        'c',
        "export const fetch = WorkloadComponent({ workload: 'other', path: '/c' })(() => {});",
      ),
    ).toThrow('must match');
    expect(() =>
      member(
        'd',
        "export const run = WorkloadService({ path: '/sync', subscriptions: [] })(() => {});",
      ),
    ).toThrow('nonempty');
  });

  it('requires paths on both kinds and rejects component/service path collisions', () => {
    for (const decorator of ['WorkloadComponent', 'WorkloadService']) {
      expect(() => member('missing', `export const run = ${decorator}({})(() => {});`)).toThrow(
        'must declare a path',
      );
      for (const path of ['relative', '//host', '/bad path', '/a?b']) {
        expect(() =>
          member(
            'invalid',
            `export const run = ${decorator}({ path: ${JSON.stringify(path)} })(() => {});`,
          ),
        ).toThrow('absolute path');
      }
    }
    const component = member(
      'component',
      "export const fetch = WorkloadComponent({ path: '/same' })(() => {});",
    );
    const service = member(
      'service',
      "export const run = WorkloadService({ path: '/same' })(async () => {});",
    );
    expect(() =>
      writeWorkloadManifest(component.projectRoot, 'warehouse', [component, service]),
    ).toThrow('both claim /same');
  });

  it('validates workload names before using them as manifest paths', () => {
    const root = makeProject({ name: 'bad', entry: 'src/app.ts', workload: '../outside' });
    expect(() => loadProject(root)).toThrow('DNS label');
  });

  it('builds service handler exports without importing a default HTTP entrypoint', async () => {
    const project = member(
      'sync',
      "export const onMessage = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(async () => {});",
    );
    const assets = makeAssets();
    cpSync(
      new URL('../assets/wit/deps/wasmcloud-messaging', import.meta.url),
      join(assets, 'wit/deps/wasmcloud-messaging'),
      { recursive: true },
    );
    const deps = fakeDeps({ cwd: project.projectRoot, assets });
    expect(requirementsForProject(project, deps)).toEqual([
      expect.objectContaining({
        package: 'wasmcloud:messaging',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
    await buildComponent(project, captureIo().io, deps);
    const adapter = readFileSync(
      join(project.projectRoot, '.di-framework/cron-adapter.js'),
      'utf8',
    );
    expect(adapter).toContain('onMessage as invoke');
    expect(adapter).toContain('handleMessage');
    expect(adapter).not.toContain('import application');
    expect(
      readFileSync(join(project.projectRoot, '.di-framework/wit/world.wit'), 'utf8'),
    ).not.toContain('wasi:http');
  });

  it('adapts a named HTTP component and enforces its route claim', async () => {
    const project = member(
      'take',
      "export const fetch = WorkloadComponent({ path: '/take' })(async () => new Response('ok'));",
    );
    await buildComponent(
      project,
      captureIo().io,
      fakeDeps({ cwd: project.projectRoot, assets: makeAssets() }),
    );
    const entry = readFileSync(
      join(project.projectRoot, '.di-framework/application-entry.js'),
      'utf8',
    );
    expect(entry).toContain('fetch as invoke');
    expect(entry).toContain('pathname !== "/take"');
    expect(entry).toContain('status: 404');
  });

  it('merges messaging imports and exports into one host interface with subscriptions', () => {
    const entries = hostInterfacesFromRequirements(
      [
        {
          package: 'wasmcloud:messaging',
          version: '0.3.0',
          interfaces: ['consumer'],
          direction: 'import',
          source: 'Sync',
        },
        {
          package: 'wasmcloud:messaging',
          version: '0.3.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'workload-service',
        },
      ],
      { subscriptions: ['warehouse.stock'] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      interfaces: ['consumer', 'handler'],
      config: { subscriptions: 'warehouse.stock' },
    });
  });
});
