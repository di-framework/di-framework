# @di-framework/queues

Durable job queues with local development and wasmCloud deployment integration for di-framework.

## Features

- **Typed Producers**: `queue.get<T>('queue-name')` / `QueueProducer<T>` with `await producer.enqueue(payload, options?)`. Enqueue calls resolve once the durable backend confirms acceptance.
- **Handler Declarations**: `@QueueHandler('receipts', { maxRetries, backoffMs, timeoutMs, concurrency })`. Handlers resolve owning services through DI, execute async methods, and acknowledge completion only after awaiting the actual async handler.
- **At-Least-Once Delivery**: Unique stable job IDs for application-level idempotency, backoff, retry limits, execution timeouts, and unacknowledged work recovery.
- **Dead-Letter Retention**: Exhausted jobs are retained for inspection and explicit retry.
- **Pluggable Backends**:
  - `InMemoryQueueBackend`: Deterministic, isolated unit tests with virtual clock (`advanceTime`), `step`, and `drain` without sleeps.
  - `SqliteQueueBackend`: Local development persistence across restarts.
  - `QueueDispatcher`: Host capability integration.
- **Tooling & wasmCloud Integration**:
  - CLI: `queue list`, `queue inspect <name>`, `queue retry <name> [jobId]`.
  - wasmCloud build/analysis discovery, private dispatch invocation, and deployment manifest generation without exposed HTTP endpoints.
