import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverActors,
  renderActorsModule,
  renderWorkloadManifest,
} from '../src/index.js';
import type { WasmcloudProject } from '../src/project.js';
import type { ClusterConnection } from '../src/target.js';

describe('wasmCloud Actor Build & Manifest Generation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmcloud-actor-build-'));

  const makeProject = (srcFiles: Record<string, string>, configExtra: Record<string, unknown> = {}): WasmcloudProject => {
    const projDir = path.join(tmp, `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const srcDir = path.join(projDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    for (const [filename, code] of Object.entries(srcFiles)) {
      fs.writeFileSync(path.join(srcDir, filename), code);
    }

    const configPath = path.join(projDir, 'di-framework.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: 'actor-app',
        entry: 'src/index.ts',
        ...configExtra,
      }),
    );

    return {
      applicationName: 'actor-app',
      configPath,
      entryPath: path.join(srcDir, 'index.ts'),
      outputPath: path.join(projDir, 'dist', 'actor-app.wasm'),
      bindingsPath: undefined,
      bindingsConfigured: false,
      bindingsRelative: 'src/bindings.ts',
      projectRoot: projDir,
      version: '1.0.0',
      witName: 'actor-app',
    };
  };

  it('scans decorated actor metadata (@Actor, @ActorMethod)', () => {
    const project = makeProject({
      'counter-actor.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';

        @Actor({ name: 'Counter', namespace: 'system' })
        export class CounterActor {
          @ActorMethod()
          async increment(step: number = 1): Promise<number> { return step; }

          @ActorMethod({ name: 'fetchCount', timeout: 5000 })
          async getCount(): Promise<number> { return 0; }
        }
      `,
      'index.ts': `
        export { CounterActor } from './counter-actor.js';
      `,
    });

    const actors = discoverActors(project);
    expect(actors.length).toBe(1);
    expect(actors[0]?.className).toBe('CounterActor');
    expect(actors[0]?.actorName).toBe('Counter');
    expect(actors[0]?.namespace).toBe('system');
    expect(actors[0]?.methods).toEqual([
      { name: 'increment', methodName: 'increment', timeout: undefined },
      { name: 'fetchCount', methodName: 'getCount', timeout: 5000 },
    ]);
  });

  it('generates explicit registration and dispatch exports module', () => {
    const project = makeProject({
      'user-actor.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';

        @Actor('User')
        export class UserActor {
          @ActorMethod()
          async getName(): Promise<string> { return 'alice'; }
        }
      `,
      'index.ts': `export { UserActor } from './user-actor.js';`,
    });

    const actors = discoverActors(project);
    const moduleSource = renderActorsModule(actors);

    expect(moduleSource).toContain("import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';");
    expect(moduleSource).toContain("import { UserActor } from");
    expect(moduleSource).toContain("actorRuntime.register(UserActor, {");
    expect(moduleSource).toContain('export async function dispatchActorInvocation(');
    expect(moduleSource).toContain('export { actorRuntime, storage, UserActor };');
    expect(moduleSource).toContain('globalThis[Symbol.for("di-framework.wasmcloud.actors")]');
  });

  it('enforces replicas: 1 for actor deployments with SQLite persistence', () => {
    const project = makeProject({
      'counter.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';
        @Actor()
        export class CounterActor {}
      `,
      'index.ts': `export { CounterActor } from './counter.ts';`,
    });

    const connection: ClusterConnection = {
      target: 'dev',
      kubeconfig: '/tmp/kubeconfig',
      context: 'dev',
      namespace: 'wasmcloud',
      registry: {
        push: 'registry.example.com',
        pull: 'registry.example.com',
        insecure: false,
      },
    };

    // Valid with replicas: 1
    const validManifest = renderWorkloadManifest(
      project,
      connection,
      'registry.example.com/actor-app:v1',
      [],
      [],
      { hasActors: true, replicas: 1 },
    );

    expect(validManifest).toContain('kind: PersistentVolumeClaim');
    expect(validManifest).toContain('name: actor-app-storage');
    expect(validManifest).toContain('replicas: 1');
    expect(validManifest).toContain('mountPath: /data/actors');
    expect(validManifest).toContain('claimName: actor-app-storage');
    expect(validManifest).toContain('ACTOR_STORAGE_DIR');
    expect(validManifest).toContain('type: Recreate');

    // Rejects replicas > 1
    expect(() =>
      renderWorkloadManifest(
        project,
        connection,
        'registry.example.com/actor-app:v1',
        [],
        [],
        { hasActors: true, replicas: 2 },
      ),
    ).toThrow('Actor deployments with SQLite persistent storage require replicas: 1');
  });
});
