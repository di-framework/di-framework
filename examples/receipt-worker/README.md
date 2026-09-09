# @examples/receipt-worker

Durable job queue worker example using `@di-framework/queues` and `@di-framework/cli-plugin-wasmcloud`.

## Features

- **Typed Queue Producer**: `ReceiptProducer` sends typed jobs to the `'receipts'` queue with idempotency keys.
- **DI-Managed Queue Handler**: `ReceiptProcessor` handles jobs with `@QueueHandler('receipts', { maxRetries: 3, backoffMs: 100, timeoutMs: 5000, concurrency: 2 })` and resolves injected services (`AuditLogService`).
- **Durable Local Storage**: Uses `SqliteQueueBackend` for persistent job tracking across application restarts.
- **wasmCloud Worker Integration**: Automatically discovered by `@di-framework/cli-plugin-wasmcloud` to render `WorkloadDeployment` with `queueConsumers` and no unnecessary HTTP endpoints.

## Running Locally

```bash
bun run dev
```
