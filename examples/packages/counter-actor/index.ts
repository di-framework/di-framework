import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';
import { CounterActor } from './counter.actor';

export async function runExample(): Promise<void> {
  console.log('=== Counter Actor Example ===');

  // 1. Configure SQLite storage and application namespace without external services
  const storage = new SqliteActorStorage({ baseDir: './.actors' });
  const runtime = new ActorRuntime({
    storage,
    namespace: 'examples',
  });

  runtime.register(CounterActor);

  // 2. Typed calls through actor reference
  const counterA = runtime.get(CounterActor, 'counter-a');
  const counterB = runtime.get(CounterActor, 'counter-b');

  console.log('Initial count A:', await counterA.getCount());

  // 3. Concurrent invocations serialized per actor mailbox
  console.log('Running concurrent increments on counter-a...');
  const results = await Promise.all([
    counterA.increment(1),
    counterA.increment(5),
    counterA.increment(10),
  ]);
  console.log('Counter A concurrent increment results:', results);
  console.log('Final count A:', await counterA.getCount());

  // 4. Multi-actor concurrency (counter-b is independent)
  await counterB.increment(100);
  console.log('Counter B count:', await counterB.getCount());

  // 5. Deactivation
  console.log('Deactivating counter-a...');
  await runtime.deactivate(CounterActor, 'counter-a');

  // 6. Persistence across restart
  console.log('Simulating process restart against same SQLite directory...');
  await runtime.clear();

  const restartRuntime = new ActorRuntime({
    storage: new SqliteActorStorage({ baseDir: './.actors' }),
    namespace: 'examples',
  });
  restartRuntime.register(CounterActor);

  const reloadedCounterA = restartRuntime.get(CounterActor, 'counter-a');
  console.log('Persisted count A after restart:', await reloadedCounterA.getCount());
  await restartRuntime.clear();

  console.log('=== Example completed successfully! ===');
}

if (import.meta.main) {
  runExample().catch(console.error);
}
