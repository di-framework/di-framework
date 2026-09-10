import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';
import {
  createWasmcloudActorAdapter,
  type WasmcloudActorAdapter,
} from '@di-framework/cli-plugin-wasmcloud';
import { CounterActor } from '../src/counter-actor';

describe('wasmCloud CounterActor Example Tests', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmcloud-counter-example-'));
  let storage: SqliteActorStorage;
  let runtime: ActorRuntime;
  let adapter: WasmcloudActorAdapter;

  const init = () => {
    storage = new SqliteActorStorage({ baseDir: tempDir, fileLocking: true });
    runtime = new ActorRuntime({ storage });
    runtime.register(CounterActor);
    adapter = createWasmcloudActorAdapter(runtime);
  };

  beforeEach(() => {
    init();
  });

  afterAll(async () => {
    if (storage) await storage.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('Local Invocation via Typed ActorRef', () => {
    it('initializes count to 0 and increments / decrements / resets', async () => {
      const counter = runtime.get(CounterActor, 'counter-local');
      expect(await counter.getCount()).toBe(0);

      expect(await counter.increment(5)).toBe(5);
      expect(await counter.increment(2)).toBe(7);
      expect(await counter.decrement(3)).toBe(4);
      expect(await counter.getCount()).toBe(4);

      expect(await counter.reset()).toBe(0);
      expect(await counter.getCount()).toBe(0);
    });

    it('rolls back transactions when an actor method fails', async () => {
      const counter = runtime.get(CounterActor, 'counter-rollback');
      await counter.increment(10);
      expect(await counter.getCount()).toBe(10);

      await expect(counter.failingAction()).rejects.toThrow('Action failed intentionally');
      expect(await counter.getCount()).toBe(10);
    });

    it('persists committed state across runtime restarts', async () => {
      const counter = runtime.get(CounterActor, 'counter-restart');
      await counter.increment(100);
      expect(await counter.getCount()).toBe(100);

      // Close and restart runtime against the same directory
      await storage.close();
      init();

      const restartedCounter = runtime.get(CounterActor, 'counter-restart');
      expect(await restartedCounter.getCount()).toBe(100);
    });
  });

  describe('Private Invocation via wasmCloud Adapter', () => {
    it('dispatches invocations through wasmCloud HTTP adapter protocol', async () => {
      const res1 = await adapter.invoke('Counter', 'counter-wasmcloud', 'increment', [25]);
      expect(res1).toBe(25);

      const res2 = await adapter.invoke('Counter', 'counter-wasmcloud', 'getCount');
      expect(res2).toBe(25);

      const res3 = await adapter.invoke('Counter', 'counter-wasmcloud', 'decrement', [5]);
      expect(res3).toBe(20);
    });

    it('strictly serializes concurrent calls through actor mailbox', async () => {
      const promises = [
        adapter.invoke('Counter', 'counter-concurrent', 'increment', [1]),
        adapter.invoke('Counter', 'counter-concurrent', 'increment', [2]),
        adapter.invoke('Counter', 'counter-concurrent', 'increment', [3]),
        adapter.invoke('Counter', 'counter-concurrent', 'increment', [4]),
      ];

      await Promise.all(promises);
      const total = await adapter.invoke('Counter', 'counter-concurrent', 'getCount');
      expect(total).toBe(10);
    });

    it('propagates transaction rollback errors through wasmCloud adapter', async () => {
      await adapter.invoke('Counter', 'counter-adapter-rollback', 'increment', [50]);

      await expect(
        adapter.invoke('Counter', 'counter-adapter-rollback', 'failingAction'),
      ).rejects.toThrow('Actor invocation failed');

      const count = await adapter.invoke('Counter', 'counter-adapter-rollback', 'getCount');
      expect(count).toBe(50);
    });
  });
});
