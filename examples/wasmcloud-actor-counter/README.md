# wasmCloud Actor Counter Example

This example demonstrates stateful virtual actors running within wasmCloud WebAssembly components with persistent SQLite storage, serialized mailbox scheduling, and schema migrations.

## Architecture & Execution Model

### 1. In-Memory Activation & Mailbox Scheduling
- **Activation Lifecycle**: Actors are instantiated on-demand when invoked and maintained in-memory within the host component instance.
- **Asynchronous Mailbox**: Calls to the same actor identity (`namespace:actorName:actorKey`) are strictly serialized in a FIFO mailbox queue, preventing concurrent state corruption within an actor instance while allowing distinct actor instances to execute concurrently.

### 2. Host Storage Binding (SQLite)
- **Filesystem Placement**: Persistent databases are bound via the host volume mounted at `/data/actors` (configured via `ACTOR_STORAGE_DIR`).
- **Database Ownership**: Each actor identity is securely hashed and isolated to its own database file (`.db`) protected by process file locks. Actor methods do not manage file placement or low-level connections.
- **Transactions**: Each actor invocation runs inside an isolated ACID transaction. Modifications committed upon method return, or rolled back cleanly when an error is thrown.
- **Migrations**: Pre-activation schema migrations run automatically. If a migration fails, the actor refuses activation and rejects incoming invocations before corrupting state.

### 3. Private Invocation
- Invocations are delivered privately via the wasmCloud adapter protocol (`/_actors/invoke` or private service bindings) without requiring public application endpoints to be exposed.

## Deployment & Safety Constraints

### Single-Host Operating Model vs. Distributed Capabilities
- **Single-Host Constraint**: To ensure safety with file-backed SQLite persistence, deployments enforce `replicas: 1`. Multiple replicas competing for the same persistent volume on multiple nodes are disallowed to prevent database split-brain.
- **Upgrade and Drain Behavior**: Rolling upgrades use the Kubernetes `Recreate` strategy so active invocations drain and lock files release before the new application version acquires storage ownership.
- **Distributed Actors**: Multi-host distributed placement, partition consensus, and remote actor remoting across wasmCloud clusters belong to distributed actor capabilities (see `@di-framework/actors` distributed roadmap).

## Running Tests

```bash
bun test
```
