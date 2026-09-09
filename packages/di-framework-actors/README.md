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

## License

MIT OR Apache-2.0

## Distributed Ownership & Remote Actor Invocations

`@di-framework/actors` provides full support for distributed actor activation, remote RPC invocation, monotonically increasing ownership generations (fencing tokens), storage fencing, request deduplication, and authorization boundaries.

### Remote RPC Dispatch & Identity

Remote actor invocations package explicit identity into every request:
- **`requestId`**: Unique client-assigned UUID for deduplication and idempotency caching.
- **`namespace`**: Application tenant or partition namespace (e.g. `billing`, `inventory`).
- **`actorType`**: Target actor class or registered name.
- **`actorKey`**: Unique instance key.
- **`method`**: Method name to execute.
- **`args`**: Serialized arguments array.
- **`callerId`**: Identity of the calling service or client.
- **`deadline`**: Epoch timestamp in milliseconds after which the request is dropped.

```ts
import {
  ActorRpcDispatcher,
  RemoteActorClient,
  MemoryActorTransport,
  ActorRuntime,
} from '@di-framework/actors';

const runtime = new ActorRuntime({ actors: [OrderActor] });
const dispatcher = new ActorRpcDispatcher({ runtime });
const transport = new MemoryActorTransport(dispatcher);

// Remote client reference
const client = new RemoteActorClient({ transport, callerId: 'gateway-service' });
const order = client.get<OrderActor>(OrderActor, 'order-42');

const result = await order.placeOrder('ord-1', 100);
```

### Authorization Boundaries & Binding Policies

Callers can be restricted from invoking unauthorized actor types, methods, or namespaces via `createActorBindingPolicy`:

```ts
import { createActorBindingPolicy, ActorRuntime } from '@di-framework/actors';

const policy = createActorBindingPolicy({
  allowedCallers: ['web-gateway', 'internal-cron'],
  allowedNamespaces: ['production', 'default'],
  allowedActorTypes: ['OrderActor'],
  allowedMethods: {
    OrderActor: ['getOrder', 'placeOrder'], // other methods rejected
  },
});

const runtime = new ActorRuntime({
  actors: [OrderActor],
  authorizationPolicy: policy,
});
```

Unauthorized requests are rejected before mailbox admission or state access with `ActorAuthorizationError`.

### Distributed Ownership Protocol & Fencing Tokens

To guarantee single-writer safety across distributed nodes:
1. **Monotonically Increasing Generations**: When an actor host acquires ownership of an actor (e.g. `node-A`), authoritative storage records an ownership record with a fencing token generation `G = 1`.
2. **Failover & Transfer**: If the owner crashes or ownership is transferred to `node-B`, the generation is atomically bumped (`G = 2`).
3. **Storage Fencing**: Authoritative storage checks ownership generation on **EVERY commit**. If a stale owner attempts to commit a transaction with an older generation, the commit is rejected with `StaleOwnerWriteError` and all staged state is rolled back.

```ts
// If node-A (gen 1) attempts commit after node-B took over (gen 2):
try {
  await tx.commit();
} catch (err) {
  if (err instanceof StaleOwnerWriteError) {
    console.error(`Rejected stale commit: owner generation ${err.ownerGeneration} superseded by storage generation ${err.storageGeneration}`);
  }
}
```

### Reliability, Deduplication & Idempotency Cache

In distributed systems, a successful commit can precede a lost response (network partition, timeout, dropped packet):
- When a client retransmits a request with the same `requestId`, the actor runtime checks the authoritative idempotency cache (`_actor_idempotency`).
- If an entry is found, the committed response is returned immediately **without re-executing non-idempotent side effects**.
- In-flight requests with identical `requestId`s are joined into the same execution promise.
- Deadlines (`deadline` timestamp) are verified before and after queue admission; expired requests throw `ActorDeadlineExceededError`.
- Mailboxes enforce bounded queue limits (`maxMailboxSize`), rejecting excess requests with `ActorBackpressureError`.

### Durability, Failure Model & Consistency Guarantees

| Property | Guarantee |
| :--- | :--- |
| **Durability** | SQLite WAL mode with atomic transactions (`BEGIN IMMEDIATE`). State and idempotency records commit atomically. |
| **Ordering** | Serialized per-actor mailbox queue. Complete asynchronous invocations execute sequentially per actor instance. |
| **Consistency** | Strong single-writer consistency backed by storage fencing tokens. Stale owner commits fail with `StaleOwnerWriteError`. |
| **Retry & Deduplication** | At-least-once transport delivery combined with storage idempotency cache guarantees exactly-once execution semantics. |
| **Storage Failure Model** | Uncommitted transactions automatically roll back on error, crash, or fencing violation. Surviving nodes recover state directly from authoritative SQLite files upon failover. |
