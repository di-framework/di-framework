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

Calling the same actor through its reference from an active invocation rejects with a reentrancy error. Call `this.otherMethod()` to share the current invocation and transaction. Indirect cycles such as A→B→A also reject while the earlier invocation remains active.

Clearing a mailbox rejects queued calls. A failed activating invocation evicts its instance so activation can initialize storage again. Timed-out instances are discarded before subsequent calls. A method timeout rolls back its storage transaction but cannot cancel JavaScript already running in the method; late storage access rejects, and the runtime observes the abandoned call's rejection.

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


## Local Development Tooling & Inspection

Virtual actors integrate directly into the `di-framework` CLI and local development runtime:

```bash
# List known actors, active activations, and pending/running mailbox calls
di-framework actor list [--namespace <name>] [--dir <path>] [--active] [--json]

# Inspect a specific actor identity without dumping private state
di-framework actor inspect <actorType|identity> [--key <key>] [--namespace <name>]

# Inspect actor including private committed state
di-framework actor inspect <actorType|identity> --show-state

# Reset persistent actor state scoped to an actor or namespace
di-framework actor reset --actor <name> [--key <key>] [--namespace <name>]
di-framework actor reset --all
```

### Hot Reload Behavior

During local development, application runtimes can be reloaded without losing persistent state:

```ts
await runtime.reload({
  policy: "drain", // or "fail" to explicitly reject unstarted pending tasks
  timeoutMs: 5000,
  actors: [UpdatedActorClass],
});
```

1. **Stops Admission**: New invocations to replaced activations are paused or closed.
2. **Drains or Fails Work**: Under `policy: "drain"` (default), pending invocations complete; under `policy: "fail"`, unstarted queued tasks are rejected with `ActorReloadError`.
3. **Releases Resources & Locks**: Calls `onDeactivate()` and releases SQLite connections and file locks, preventing overlapping owners.
4. **Applies Pending Migrations**: Clears migration cache so newly added migrations are safely applied before new calls resume.
5. **Preserves Committed State**: SQLite database files are strictly preserved across reloads.

### Scoped Reset vs Startup/Reload

- **Startup and reload never delete persistent state**.
- Persistent database state is only removed through explicit, scoped developer commands:
  - `runtime.reset({ actorName: "MyActor", actorKey: "key-1" })`
  - `runtime.reset({ namespace: "tenant-a" })`
  - `di-framework actor reset --actor MyActor --key key-1`
  - `di-framework actor clean --all`

### Multi-Application Workspaces & Namespace Isolation

Actors can be partitioned across applications and namespaces:

```ts
const runtimeA = new ActorRuntime({ storage, namespace: "app-a" });
const runtimeB = new ActorRuntime({ storage, namespace: "app-b" });

runtimeA.register(CounterActor);
runtimeB.register(CounterActor);
```

If duplicate actor names are registered within the same runtime, lookups by typed class reference or qualified name (`app-a:CounterActor`) resolve unambiguously, while ambiguous short name lookups throw `ActorAmbiguityError`.

### Discovery & Code Generation

Decorated actor classes can be discovered across source trees:

```ts
import { discoverActorClasses, generateActorRegistration } from "@di-framework/actors";

const actors = await discoverActorClasses({ rootDir: "src" });
const registrationCode = generateActorRegistration(actors);
```

## License

MIT OR Apache-2.0

SQLite actor inspection records original identities separately from sanitized filenames. Legacy files without identity metadata expose a filename-derived display key with `identityInferred: true`; accessing the actor by its original identity upgrades that metadata.

A reload timeout aborts reload and restores admission without closing an active transaction. With the `fail` policy, queued calls already rejected remain rejected; the running call can still finish. Retry reload after it completes.
