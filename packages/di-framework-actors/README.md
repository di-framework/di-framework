# @di-framework/actors

Local virtual actor runtime for `di-framework`, featuring serialized asynchronous invocations per actor, concurrent execution across actors, and transactional in-memory storage.

## Features

- **Actor Model Decorators**: Annotate classes with `@Actor`, methods with `@ActorMethod`, and inject context with `ActorContext`.
- **Typed Actor References**: Obtain type-safe references to actors via `actors.get(ActorClass, actorKey)`.
- **Per-Actor Asynchronous Serialization**: Invocations to a single actor are strictly serialized via a mailbox queue.
- **Concurrent Multi-Actor Execution**: Different actor instances execute in parallel without cross-actor blocking.
- **Transactional In-Memory Storage**: Built-in transactional key-value state for each actor with automatic commit on method success and rollback on exceptions.
- **Explicit Test Harness**: Full support for standalone unit tests via explicit class registration (`actors.register(...)`) without requiring build-time discovery.
- **Zero Heavy Dependencies**: Pure TypeScript, in-memory local runtime with no SQLite, Wasm, or external infrastructure required.

## Installation

```bash
bun add @di-framework/actors
```

## Quick Start

```ts
import { Actor, ActorMethod, ActorContext, actors } from '@di-framework/actors';

@Actor()
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

// Explicit registration in test or application setup
actors.register(BankAccountActor);

// Obtain typed actor reference
const account = actors.get(BankAccountActor, 'account-123');

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

Calling the same actor through its reference from an active invocation rejects with a reentrancy error. Call `this.otherMethod()` to share the current invocation and transaction. Avoid cyclic reference calls across actors, which can also wait on each other's mailboxes.

Clearing a mailbox rejects queued calls. A method timeout rolls back its storage transaction but cannot cancel JavaScript already running in the method; late storage access rejects, and the runtime observes the abandoned call's rejection.

## Unit Testing with Isolated Runtimes

For test isolation, instantiate a fresh `ActorRuntime`:

```ts
import { ActorRuntime, InMemoryActorStorage } from '@di-framework/actors';

const storage = new InMemoryActorStorage();
const runtime = new ActorRuntime({ storage });

runtime.register(MyActor);
const ref = runtime.get(MyActor, 'test-key');
```

## License

MIT OR Apache-2.0
