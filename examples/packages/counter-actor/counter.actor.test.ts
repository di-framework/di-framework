import { expect, it } from 'bun:test';
import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';
import { CounterActor } from './counter.actor';

it('migrates and exercises the persistent counter lifecycle', async () => {
  const storage = SqliteActorStorage.temporary();
  const runtime = new ActorRuntime({ storage, actors: [CounterActor] });
  try {
    const counter = runtime.get(CounterActor, 'example');
    expect(await counter.getCount()).toBe(0);
    const db = await storage.getDatabase('examples:CounterActor:example');
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'counter_stats'").get(),
    ).toBeTruthy();
    expect(await counter.increment(4)).toBe(4);
    expect(await counter.decrement()).toBe(3);
    await counter.reset();
    expect(await counter.getCount()).toBe(0);
    expect(await runtime.deactivate(CounterActor, 'example')).toBe(true);
    expect(await counter.increment()).toBe(1);
  } finally {
    await runtime.clear();
  }
});
