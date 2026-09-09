import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActorRuntime, discoverActorClasses, generateActorRegistration } from '../src/index.js';

describe('Actor Discovery and Registration Tooling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-disc-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('discovers decorated actor classes and generates registration code', async () => {
    // Write sample actor file
    const actorCode = `
import { Actor, ActorMethod } from "${path.resolve('packages/di-framework-actors/src/index.ts')}";

@Actor({ name: "DiscoveredCounter", namespace: "disc-app" })
export class DiscoveredCounter {
  @ActorMethod()
  async getStatus(): Promise<string> {
    return "ok";
  }
}
`;

    const actorFile = path.join(tmpDir, 'counter.actor.ts');
    fs.writeFileSync(actorFile, actorCode, 'utf8');

    const discovered = await discoverActorClasses({ rootDir: tmpDir });
    expect(discovered.length).toBe(1);

    const first = discovered[0]!;
    expect(first.name).toBe('DiscoveredCounter');
    expect(first.namespace).toBe('disc-app');
    expect(first.methods).toContain('getStatus');
    expect(first.exportName).toBe('DiscoveredCounter');

    // Test generated code
    const generated = generateActorRegistration(discovered, {
      outFilePath: path.join(tmpDir, 'registry.ts'),
    });

    expect(generated).toContain('registerDiscoveredActors');
    expect(generated).toContain('runtime.register(DiscoveredActor0');

    // Test registering discovered class directly into runtime
    const runtime = new ActorRuntime();
    runtime.register(first.ctor, {
      name: first.name,
      namespace: first.namespace,
    });

    const ref = runtime.get<any>(first.ctor, 'key-1');
    expect(await (ref as any).getStatus()).toBe('ok');
    await runtime.clear();
  });
});
