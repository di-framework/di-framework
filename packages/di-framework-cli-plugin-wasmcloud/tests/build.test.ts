import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildComponent, requirementsForProject, runWasmcloudBuild } from '../src/build';
import { loadProject } from '../src/project';
import { captureIo, fakeDeps, makeAssets, makeProject, type RunnerInvocation } from './helpers';

describe('buildComponent', () => {
  it('writes the generated WIT world, manifests, bundle, and runs jco componentize', async () => {
    const root = makeProject();
    const assets = makeAssets();
    const invocations: RunnerInvocation[] = [];
    const deps = fakeDeps({ cwd: root, assets, invocations });
    const output = captureIo();

    const summary = await buildComponent(loadProject(root), output.io, deps);

    const generated = join(root, '.di-framework');
    expect(readFileSync(join(generated, 'wit', 'world.wit'), 'utf8')).toBe(
      'package local:demo-app@1.2.3;\n\nworld application {\n  export wasi:http/handler@0.3.0;\n}\n',
    );
    expect(JSON.parse(readFileSync(join(generated, 'oci-config.json'), 'utf8'))).toEqual({
      architecture: 'wasm',
      os: 'wasip2',
    });
    const lock = JSON.parse(readFileSync(join(generated, 'wit.lock.json'), 'utf8')) as {
      componentModel: string;
      requirements: Array<{ package: string; version: string; interfaces: string[] }>;
    };
    expect(lock.componentModel).toBe('0.3');
    expect(lock.requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:http',
        version: '0.3.0',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
    expect(JSON.parse(readFileSync(join(generated, 'build.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      application: 'Demo App',
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      component: join('dist', 'demo-app.wasm'),
      componentModel: '0.3',
      deploymentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entry: join('src', 'app.ts'),
      profile: 'wasmcloud-http',
    });
    expect(existsSync(join(generated, 'wit', 'deps', 'wasi-http', 'package.wit'))).toBe(true);
    expect(existsSync(join(generated, 'component.js'))).toBe(true);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: '/fake/node',
      cwd: root,
      args: [
        '/fake/jco.js',
        'componentize',
        '--backend',
        'qjs',
        '-w',
        join(generated, 'wit'),
        '-n',
        'application',
        '-o',
        join(root, 'dist', 'demo-app.wasm'),
        join(generated, 'component.js'),
      ],
    });
    expect(summary).toEqual({
      application: 'Demo App',
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      component: join('dist', 'demo-app.wasm'),
      componentModel: '0.3',
      deploymentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entry: join('src', 'app.ts'),
      profile: 'wasmcloud-http',
    });
    expect(output.stdout.join('')).toContain('Building Demo App');
    expect(output.stdout.join('')).toContain('Built dist/demo-app.wasm');
    expect(existsSync(join(generated, 'guests.js'))).toBe(false);
  });

  it('writes a guests module when bindings are discovered', async () => {
    const root = makeProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Config, Postgres, WasmCloudBinding } from '@di-framework/wasmcloud';
@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}
@WasmCloudBinding('app-config')
export class AppConfig extends Config {}
`,
    );
    writeFileSync(
      join(root, 'catalog.json'),
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
        Config: {
          kind: 'Config',
          package: 'wasi:config',
          version: '0.2.0-rc.1',
          interfaces: ['store'],
          primaryInterface: 'store',
          namedInstance: false,
          sharedResources: [],
          witDep: 'wasi-config',
          usesSecret: false,
          configKeys: [],
        },
      })}\n`,
    );
    const assets = makeAssets();
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        resolutions: { '@di-framework/wasmcloud/catalog.json': join(root, 'catalog.json') },
      }),
    );
    expect(summary.application).toBe('Demo App');
    const guests = readFileSync(join(root, '.di-framework', 'guests.js'), 'utf8');
    expect(guests).toContain('import * as');
    expect(guests).toContain('wasmcloud:postgres/query@0.2.0');
    expect(guests).toContain('wasi:config/store@0.2.0-rc.1');
    expect(guests).toContain('"user-database"');
    expect(guests).toContain('Symbol.for("di-framework.wasmcloud.guests")');
    expect(readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8')).toContain(
      'import wasmcloud:postgres/query@0.2.0;',
    );
    expect(readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8')).not.toContain(
      'import user-database:',
    );
  });

  it('inspects real wasm imports and fails when they disagree with the WIT graph', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Postgres, WasmCloudBinding } from '@di-framework/wasmcloud';
@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}
`,
    );
    writeFileSync(
      join(root, 'catalog.json'),
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
      })}\n`,
    );
    const assets = makeAssets();
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets,
          resolutions: { '@di-framework/wasmcloud/catalog.json': join(root, 'catalog.json') },
          componentOutput: () => `\0asm missing-imports`,
          capturedStdout: { wit: 'world application {\n  export wasi:http/handler@0.3.0;\n}\n' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPONENT_IMPORTS_MISMATCH', exitCode: 3 });
  });

  it('accepts a component whose extracted WIT includes declared imports', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Postgres, WasmCloudBinding } from '@di-framework/wasmcloud';
@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}
`,
    );
    writeFileSync(
      join(root, 'catalog.json'),
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
      })}\n`,
    );
    const assets = makeAssets();
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        resolutions: { '@di-framework/wasmcloud/catalog.json': join(root, 'catalog.json') },
        componentOutput: () => `\0asm ok`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import wasmcloud:postgres/query@0.2.0;
  import wasmcloud:postgres/prepared@0.2.0;
  import wasmcloud:postgres/types@0.2.0;
}
`,
        },
      }),
    );
    expect(summary.componentModel).toBe('0.3');
  });

  it('fails when component WIT cannot be extracted from a real wasm', async () => {
    const root = makeProject();
    const assets = makeAssets();
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets,
          componentOutput: () => `\0asm unreadable`,
          exitCodes: { wit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPONENT_IMPORTS_UNREADABLE', exitCode: 3 });
  });

  it('keeps the deployment version stable when componentizer bytes vary for identical inputs', async () => {
    const root = makeProject();
    const assets = makeAssets();
    const deps = fakeDeps({
      cwd: root,
      assets,
      componentOutput: (build) => `nondeterministic-component-${build}`,
    });

    const first = await buildComponent(loadProject(root), captureIo().io, deps);
    const second = await buildComponent(loadProject(root), captureIo().io, deps);

    expect(first.artifactDigest).not.toBe(second.artifactDigest);
    expect(first.deploymentDigest).toBe(second.deploymentDigest);
  });

  it('maps bundler failures to WASMCLOUD_BUILD_FAILED', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, bundlerError: new Error('rolldown exploded') });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_BUILD_FAILED',
      exitCode: 3,
    });
  });

  it('fails with WASMCLOUD_NODE_REQUIRED when no node binary is available', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, nodeBinaryPath: null });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_NODE_REQUIRED',
      exitCode: 3,
    });
  });

  it('maps jco componentize failures to WASMCLOUD_TOOL_FAILED', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, exitCodes: { componentize: 1 } });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      exitCode: 3,
    });
  });

  it('componentizes with a patched qjs CLI when DI_FRAMEWORK_COMPONENTIZE_QJS is set', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        componentizeQjsPath: '/fake/componentize-qjs',
      }),
    );
    expect(invocations[0]).toMatchObject({
      command: '/fake/componentize-qjs',
      cwd: root,
      args: [
        '--wit',
        join(root, '.di-framework', 'wit'),
        '--js',
        join(root, '.di-framework', 'component.js'),
        '-n',
        'application',
        '-o',
        join(root, 'dist', 'demo-app.wasm'),
      ],
    });
  });
});

describe('requirementsForProject', () => {
  it('returns HTTP adapter requirements when no bindings file exists', () => {
    const root = makeProject();
    const requirements = requirementsForProject(loadProject(root), fakeDeps({ cwd: root }));
    expect(requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:http',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
  });
});

describe('runWasmcloudBuild', () => {
  it('rejects arguments before touching the project', async () => {
    await expect(
      runWasmcloudBuild(['--watch'], captureIo().io, fakeDeps({ cwd: '/nowhere' })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 });
  });

  it('builds the project found from the working directory', async () => {
    const root = makeProject();
    const result = await runWasmcloudBuild(
      [],
      captureIo().io,
      fakeDeps({ cwd: join(root, 'src') }),
    );
    expect(result.data).toMatchObject({ application: 'Demo App', profile: 'wasmcloud-http' });
    expect(result.text).toContain('Built');
  });
});
