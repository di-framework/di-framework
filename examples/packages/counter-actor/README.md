# Counter Actor Example

Working example demonstrating local virtual actors in `di-framework` with local SQLite persistence and no external services or Wasm tooling.

## Features Demonstrated

1. **Typed calls**: `runtime.get(CounterActor, primary)` provides fully typed method proxy.
2. **Concurrent invocations**: Multiple simultaneous calls are strictly serialized per actor key through its mailbox queue.
3. **Multi-actor concurrency**: Distinct actor keys execute concurrently.
4. **Actor schema migrations**: Automatic execution of `@ActorMigration` definitions before first activation.
5. **Persistence across restart**: Committed transactional state in SQLite survives deactivation and process restarts.
6. **Zero external dependencies**: Uses Bun and local SQLite files, requiring no external daemons, containers, or Wasm tools.

## Running

```bash
# Run the example directly
bun run index.ts

# Run tests
bun test
```

## CLI Inspection and Reset

```bash
# List known actors
di-framework actor list --namespace examples

# Inspect actor without dumping private state
di-framework actor inspect CounterActor --key primary --namespace examples

# Inspect with committed state
di-framework actor inspect CounterActor --key primary --namespace examples --show-state

# Reset actor storage
di-framework actor reset --actor CounterActor --namespace examples
```
