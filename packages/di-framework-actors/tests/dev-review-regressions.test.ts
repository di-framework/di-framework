import { expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearDecoratedActorClasses, getDecoratedActorClasses } from '../src/decorators/keys';
import {
  Actor,
  ActorAdmissionClosedError,
  ActorDevManager,
  ActorRuntime,
  discoverActorClasses,
  generateActorRegistration,
  SqliteActorStorage,
} from '../src/index';
import { ActorMailbox } from '../src/runtime/mailbox';
import { createActorReference } from '../src/runtime/reference';

it('preserves in-memory state across eviction, idle cleanup and scoped reload', async () => {
  const storage = new SqliteActorStorage({ inMemory: true, maxConnections: 1, idleTimeoutMs: 1 });
  try {
    await storage.set('app:Counter:a', 'count', 7);
    await storage.set('app:Counter:b', 'count', 9);
    expect(await storage.get<number>('app:Counter:a', 'count')).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await storage.cleanupIdleConnections()).toBe(1);
    expect(await storage.get<number>('app:Counter:a', 'count')).toBe(7);
    await storage.closeActor('app:Counter:a');
    expect(await storage.get<number>('app:Counter:a', 'count')).toBe(7);
    await storage.resetStorage({ namespace: 'app', actorName: 'Counter', actorKey: 'b' });
    expect(await storage.get('app:Counter:b', 'count')).toBeUndefined();
  } finally {
    await storage.close();
  }

  @Actor({ namespace: 'app' })
  class Named {
    read() {
      return 1;
    }
  }
  const runtime = new ActorRuntime({ actors: [Named] });
  expect(runtime.isRegistered('app:Named')).toBe(true);
  expect(runtime.isRegistered(Named)).toBe(true);
  const result = await runtime.reload({ namespace: 'app' });
  expect(result.reloadedActors).toEqual(['Named']);
  await runtime.clear();
});

it('discovers and registers actors through runtime and development manager', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'actor-dev-review-'));
  const runtime = new ActorRuntime({ namespace: 'review' });
  const manager = new ActorDevManager({ runtime, cwd: dir });
  expect(runtime.namespace).toBe('review');
  expect(runtime.storage).toBe(manager.runtime.storage);
  const read = fs.readFileSync;
  try {
    fs.mkdirSync(join(dir, 'nested'));
    fs.writeFileSync(join(dir, 'plain.ts'), 'export const value = 1');
    fs.writeFileSync(join(dir, 'broken.ts'), '@Actor invalid code');
    const file = join(dir, 'nested', 'worker.ts');
    fs.writeFileSync(
      file,
      `import { Actor } from ${JSON.stringify(resolve('packages/di-framework-actors/src/index.ts'))};\n@Actor() export class Worker { ping() { return 'pong'; } }`,
    );
    expect(await discoverActorClasses({ rootDir: join(dir, 'missing') })).toEqual([]);
    expect(generateActorRegistration([])).toContain('No decorated actors');
    const unreadable = spyOn(fs, 'readFileSync').mockImplementation(((
      path: any,
      ...args: any[]
    ) => {
      if (path === file) throw new Error('unreadable');
      return (read as any)(path, ...args);
    }) as typeof fs.readFileSync);
    try {
      expect(await discoverActorClasses({ cwd: dir })).toEqual([]);
    } finally {
      unreadable.mockRestore();
    }
    const found = await manager.discoverAndRegister();
    expect(found).toHaveLength(1);
    expect(await runtime.get<{ ping(): Promise<string> }>('Worker', 'key').ping()).toBe('pong');
    expect(runtime.isRegistered('Worker')).toBe(true);
    expect(runtime.isRegistered('absent')).toBe(false);
    expect(await manager.inspect('Worker', 'key')).toMatchObject({ status: 'active' });
    expect(await manager.list({ activeOnly: true })).toHaveLength(1);
    expect((await manager.reload()).success).toBe(true);
    expect(await runtime.discoverAndRegister({ cwd: dir })).toHaveLength(1);
    expect((await manager.reset({ all: true })).success).toBe(true);
    expect(getDecoratedActorClasses().length).toBeGreaterThan(0);
    clearDecoratedActorClasses();
    expect(getDecoratedActorClasses()).toEqual([]);
  } finally {
    await manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('resumes mailbox admission and preserves reference identity', async () => {
  const mailbox = new ActorMailbox();
  mailbox.stopAdmission();
  expect(mailbox.isAdmissionClosed).toBe(true);
  await expect(mailbox.enqueue(async () => 1)).rejects.toBeInstanceOf(ActorAdmissionClosedError);
  mailbox.resumeAdmission();
  expect(mailbox.isAdmissionClosed).toBe(false);
  expect(await mailbox.enqueue(async () => 2)).toBe(2);
  await mailbox.drain();
  expect(new ActorAdmissionClosedError().name).toBe('ActorAdmissionClosedError');
  const ref = createActorReference('app:Counter', 'key', { invoke: async () => 3 });
  expect(ref.actorType).toBe('Counter');
  expect(ref.actorKey).toBe('key');
  expect(ref.id).toBe('Counter:key');
  expect(await Promise.resolve(ref)).toBe(ref);
  expect((ref as any)[Symbol.iterator]).toBeUndefined();
  expect(await (ref as any).read()).toBe(3);
});

it('generates valid registration code for default exports, aliases and duplicate export names', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'actor-codegen-review-'));
  const actorImport = resolve('packages/di-framework-actors/src/index.ts');
  try {
    const file = join(dir, 'first.js');
    const second = join(dir, 'second.js');
    fs.writeFileSync(file, 'export default class Named {}');
    fs.writeFileSync(second, 'export class Named {}');
    class Placeholder {}
    const descriptors = [
      {
        name: "first-actor's-name",
        namespace: "ns'one",
        ctor: Placeholder,
        filePath: file,
        exportName: 'default',
        methods: [],
        migrationsCount: 0,
      },
      {
        name: 'second',
        ctor: Placeholder,
        filePath: second,
        exportName: 'Named',
        methods: [],
        migrationsCount: 0,
      },
    ];
    const generated = generateActorRegistration(descriptors, {
      outFilePath: join(dir, 'registry.ts'),
      importRuntimePath: actorImport,
    });
    const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(generated);
    fs.writeFileSync(join(dir, 'registry.js'), code);
    const { registerDiscoveredActors } = await import(join(dir, 'registry.js'));
    const registrations: any[] = [];
    registerDiscoveredActors({
      register: (ctor: any, options: any) => registrations.push({ ctor, ...options }),
    });
    expect(registrations.map((r) => r.name)).toEqual(["first-actor's-name", 'second']);
    expect(registrations[0].namespace).toBe("ns'one");
    expect(registrations[0].ctor).not.toBe(registrations[1].ctor);
    expect(generateActorRegistration(descriptors)).toContain('DiscoveredActor0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
