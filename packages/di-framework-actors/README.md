# @di-framework/actors

Local virtual actor runtime for `di-framework`, featuring serialized asynchronous invocations per actor, concurrent execution across actors, transactional storage (in-memory and SQLite), and schema migrations.

## Features

- **Actor Model Decorators**: Annotate classes with `@Actor`, methods with `@ActorMethod`, and inject context with `ActorContext`.
- **Typed Actor References**: Obtain type-safe references to actors via `actors.get(ActorClass, actorKey)`.
- **Per-Actor Asynchronous Serialization**: Invocations to a single actor are strictly serialized via a mailbox queue.
- **Concurrent Multi-Actor Execution**: Different actor instances execute in parallel without cross-actor blocking.
- **SQLite Storage & Persistence**: Built-in SQLite storage adapter (`SqliteActorStorage`) with lazily opened databases per actor, bounded connection caching, idle connection cleanup, and single-writer process file locking.
- **Transactional State**: Built-in transactional storage for each actor with automatic commit on method success and rollback on exceptions. State persists across actor deactivation and process restart.
- **Safe Path Mapping**: Robust, sanitizing and hashing mapper from actor identity `(namespace, actorName, actorKey)` to filesystem paths, preventing directory traversal.
- **Actor Migrations**: First-class actor schema migrations reusing the `@di-framework/repo` migration runner. Pending migrations apply automatically before allowing an actor activation to process calls; failed migrations safely prevent activation.
- **Explicit Test Harness**: Full support for standalone unit tests via explicit class registration (`actors.register(...)`) with in-memory or temporary SQLite databases (`SqliteActorStorage.temporary()`).

## Installation

```bash
bun add @di-framework/actors
```

## Quick Start with SQLite Persistence

```ts
import {
  Actor,
  ActorMethod,
  ActorContext,
  ActorRuntime,
  SqliteActorStorage,
} from '@di-framework/actors';

@Actor({
  name: 'BankAccountActor',
  migrations: [
    {
      version: 1,
      description: 'initialize account schema',
      up: async (ctx) => {
        // Run DDL directly in actor SQLite database or initialize storage
        await ctx.run('CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT);');
      },
    },
  ],
})
class BankAccountActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async deposit(amount: number): Promise<number> {
    const current = (await this.ctx.storage.get<number>('balance')) ?? 0;
    const updated = current + amount;
    await this.ctx.storage.set('balance', updated);
    return updated;
  }

  @ActorMethod()
  async withdraw(amount: number): Promise<number> {
    const current = (await this.ctx.storage.get<number>('balance')) ?? 0;
    if (amount > current) {
      throw new Error('Insufficient funds');
    }
    const updated = current - amount;
    await this.ctx.storage.set('balance', updated);
    return updated;
  }

  @ActorMethod()
  async getBalance(): Promise<number> {
    return (await this.ctx.storage.get<number>('balance')) ?? 0;
  }
}

// Instantiate runtime with SQLite persistence
const storage = new SqliteActorStorage({ baseDir: './.actors' });
const runtime = new ActorRuntime({ storage });
runtime.register(BankAccountActor);

// Obtain typed actor reference
const account = runtime.get(BankAccountActor, 'account-123');

await account.deposit(100);
console.log(await account.getBalance()); // 100

// Invocations are transactional:
try {
  await account.withdraw(200); // Throws Insufficient funds
} catch (err) {
  // Storage transaction rolled back automatically!
}

console.log(await account.getBalance()); // Still 100!
```

## Concurrency & Serialization Guarantees

1. **Serialized Per Actor**: All method invocations on `actors.get(AccountActor, 'A')` run one-by-one. An invocation must fully complete (including asynchronous `await`s) before the next invocation on the same actor begins.
2. **Concurrent Across Actors**: Calls to `actors.get(AccountActor, 'A')` and `actors.get(AccountActor, 'B')` execute concurrently.
3. **Single Writer Safety**: Explicit file locking prevents multiple processes or runtimes from concurrently mutating the same actor database.

## Unit Testing with Isolated Temporary SQLite Storage

For tests, use `SqliteActorStorage.temporary()` or `{ inMemory: true }`:

```ts
import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';

const storage = SqliteActorStorage.temporary();
const runtime = new ActorRuntime({ storage });

runtime.register(MyActor);
const ref = runtime.get(MyActor, 'test-key');

// Cleanup temporary directory and connection locks after test run
await runtime.clear();
await storage.close();
```


## wasmCloud Component & Deployment Integration

Virtual actors are supported directly in wasmCloud WebAssembly components through `@di-framework/cli-plugin-wasmcloud`.

### Runtime Execution Model
- **Activation & Mailboxes**: Actor instances and mailbox queues reside in-memory within the guest WebAssembly component.
- **Host Storage Binding**: SQLite persistent storage is mapped through host volume mounts (e.g. `/data/actors`, controlled via `ACTOR_STORAGE_DIR`). Actor methods interact with transactional storage without managing low-level guest filesystem handles.
- **Pre-Activation Migrations**: Schema migrations run prior to enabling an actor to process calls. If a migration fails, the actor is not activated.

### Single-Host Safety vs. Distributed Capabilities
- **Single-Host Model**: The initial wasmCloud actor deployment model provides resilient single-host execution with persistent volume storage and single-writer SQLite locking. Workload manifests strictly enforce `replicas: 1` and use `strategy: { type: "Recreate" }` for draining in-flight calls and releasing file locks before a new application version starts.
- **Distributed Capabilities**: Multi-host clustering, partitioned actor placement across wasmCloud nodes, and distributed consensus are handled by distributed actor extensions (Issue #410).

## License

MIT OR Apache-2.0
