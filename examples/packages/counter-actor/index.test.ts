import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';
import { CounterActor } from './counter.actor.js';

describe('Counter Actor Example Application', () => {
  let tmpDir: string;
  let storage: SqliteActorStorage;
  let runtime: ActorRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-counter-'));
    storage = new SqliteActorStorage({ baseDir: tmpDir });
    runtime = new ActorRuntime({ storage, namespace: 'examples' });
    runtime.register(CounterActor);
  });

  afterEach(async () => {
    await runtime.clear();
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('demonstrates typed calls, concurrent serialization, deactivation, and persistence across restart', async () => {
    const counter = runtime.get(CounterActor, 'primary');
    expect(await counter.getCount()).toBe(0);

    // Concurrent invocations serialized per actor mailbox
    const results = await Promise.all([
      counter.increment(1),
      counter.increment(2),
      counter.increment(3),
    ]);

    expect(results).toContain(1);
    expect(results).toContain(3);
    expect(results).toContain(6);
    expect(await counter.getCount()).toBe(6);

    // Deactivation
    const deactivated = await runtime.deactivate(CounterActor, 'primary');
    expect(deactivated).toBe(true);

    // Persistence across restart with local SQLite
    await runtime.clear();

    const restartRuntime = new ActorRuntime({
      storage: new SqliteActorStorage({ baseDir: tmpDir }),
      namespace: 'examples',
    });
    restartRuntime.register(CounterActor);

    const reloaded = restartRuntime.get(CounterActor, 'primary');
    expect(await reloaded.getCount()).toBe(6);

    await reloaded.increment(4);
    expect(await reloaded.getCount()).toBe(10);
    await restartRuntime.clear();
  });
});
