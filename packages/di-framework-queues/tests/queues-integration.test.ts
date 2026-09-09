import { describe, expect, it } from 'bun:test';
import { container as globalContainer } from '@di-framework/core';
import { Component, Container } from '@di-framework/core/decorators';
import { InMemoryQueueBackend } from '../src/backend/memory.js';
import { SqliteQueueBackend } from '../src/backend/sqlite.js';
import { QueueHandler } from '../src/decorators.js';
import { ContainerQueueDispatcher } from '../src/dispatcher.js';
import { QueueManager } from '../src/producer.js';
import type { JobMetadata } from '../src/types.js';
import { QueueWorker } from '../src/worker.js';

describe('Queues Integration', () => {
  it('resolves owning service through DI, processes job, and acknowledges only after async completion', async () => {
    const backend = new InMemoryQueueBackend();
    const manager = new QueueManager(backend);

    const callLog: string[] = [];
    let asyncCompleted = false;

    @Container()
    class ReceiptAuditService {
      record(id: string) {
        callLog.push(`audit:${id}`);
      }
    }

    @Container()
    class ReceiptWorkerService {
      constructor(@Component(ReceiptAuditService) private readonly audit: ReceiptAuditService) {}

      @QueueHandler('receipts', { maxRetries: 3, concurrency: 1 })
      async process(payload: { receiptId: string; amount: number }, meta: JobMetadata) {
        callLog.push(`start:${payload.receiptId}`);
        this.audit.record(payload.receiptId);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        asyncCompleted = true;
        callLog.push(`end:${payload.receiptId}:${meta.jobId}`);
      }
    }

    const dispatcher = new ContainerQueueDispatcher(globalContainer);
    const worker = new QueueWorker(backend, dispatcher, { pollIntervalMs: 10 });
    worker.registerQueue('receipts');

    const producer = manager.get<{ receiptId: string; amount: number }>('receipts');
    const job = await producer.enqueue({ receiptId: 'rec-123', amount: 45.5 });

    expect(job.status).toBe('pending');
    expect(asyncCompleted).toBe(false);

    await worker.start();

    // Wait until completed
    const maxWait = Date.now() + 1000;
    while (Date.now() < maxWait) {
      const current = await backend.getJob(job.id);
      if (current?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const completed = await backend.getJob(job.id);
    expect(completed!.status).toBe('completed');
    expect(asyncCompleted).toBe(true);
    expect(callLog).toEqual(['start:rec-123', 'audit:rec-123', `end:rec-123:${job.id}`]);

    await worker.stop();
  });

  it('handles execution timeouts and records failure', async () => {
    const backend = new InMemoryQueueBackend();
    const dispatcher = new ContainerQueueDispatcher(globalContainer);

    @Container()
    class SlowWorkerService {
      @QueueHandler('slow-jobs', { timeoutMs: 50, maxRetries: 1 })
      async slowOperation() {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const worker = new QueueWorker(backend, dispatcher, { pollIntervalMs: 10 });
    worker.registerQueue('slow-jobs');

    const job = await backend.enqueue('slow-jobs', {}, { timeoutMs: 50, maxRetries: 1 });
    await worker.start();

    const maxWait = Date.now() + 1000;
    while (Date.now() < maxWait) {
      const current = await backend.getJob(job.id);
      if (current?.status === 'dead-letter') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const failed = await backend.getJob(job.id);
    expect(failed!.status).toBe('dead-letter');
    expect(failed!.errorMessage).toContain('timed out after 50ms');

    await worker.stop();
  });

  it('cleanly stops consumers without leaving orphan workers running', async () => {
    const backend = new InMemoryQueueBackend();
    const worker = new QueueWorker(backend);
    worker.registerQueue('test-queue');

    await worker.start();
    expect(worker.isRunning()).toBe(true);

    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('coordinates multiple workers processing concurrently with SQLite backend', async () => {
    const backend = new SqliteQueueBackend(':memory:');
    const processedIds: string[] = [];

    @Container()
    class MultiWorkerService {
      @QueueHandler('batch-items', { concurrency: 2 })
      async handleItem(item: { itemId: string }) {
        processedIds.push(item.itemId);
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    const dispatcher = new ContainerQueueDispatcher(globalContainer);
    const worker1 = new QueueWorker(backend, dispatcher, { pollIntervalMs: 5, concurrency: 2 });
    const worker2 = new QueueWorker(backend, dispatcher, { pollIntervalMs: 5, concurrency: 2 });
    worker1.registerQueue('batch-items');
    worker2.registerQueue('batch-items');

    for (let i = 1; i <= 10; i++) {
      await backend.enqueue('batch-items', { itemId: `item-${i}` });
    }

    await Promise.all([worker1.start(), worker2.start()]);

    const maxWait = Date.now() + 2000;
    while (Date.now() < maxWait) {
      const stats = await backend.listQueues();
      if (stats[0]?.completed === 10) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const finalStats = await backend.listQueues();
    expect(finalStats[0]!.completed).toBe(10);
    expect(processedIds.length).toBe(10);

    await Promise.all([worker1.stop(), worker2.stop()]);
    await backend.close();
  });
});
