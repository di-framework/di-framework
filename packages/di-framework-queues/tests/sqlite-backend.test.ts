import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteQueueBackend } from '../src/backend/sqlite.js';

describe('SqliteQueueBackend', () => {
  it('enqueues, dequeues, and completes jobs with SQLite storage', async () => {
    const backend = new SqliteQueueBackend(':memory:');
    const job = await backend.enqueue('notifications', { userId: 'u-1', message: 'Hello' });

    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.payload).toEqual({ userId: 'u-1', message: 'Hello' });

    const dequeued = await backend.dequeue('notifications');
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(job.id);
    expect(dequeued!.status).toBe('processing');
    expect(dequeued!.attempts).toBe(1);

    await backend.complete(job.id);
    const completed = await backend.getJob(job.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBeDefined();

    await backend.close();
  });

  it('supports idempotency across repeated enqueues', async () => {
    const backend = new SqliteQueueBackend(':memory:');
    const j1 = await backend.enqueue('payments', { txnId: 'tx-100', amount: 50 }, { idempotencyKey: 'charge-tx-100' });
    const j2 = await backend.enqueue('payments', { txnId: 'tx-100', amount: 50 }, { idempotencyKey: 'charge-tx-100' });

    expect(j1.id).toBe(j2.id);
    const jobs = await backend.listJobs('payments');
    expect(jobs.length).toBe(1);

    await backend.close();
  });

  it('retries up to maxRetries and retains dead-letter jobs', async () => {
    const backend = new SqliteQueueBackend(':memory:');
    const job = await backend.enqueue('sync', { ref: '123' }, { maxRetries: 2, backoffMs: 10 });

    const d1 = await backend.dequeue('sync');
    await backend.fail(d1!.id, new Error('Database connection failed'), 10);

    const check1 = await backend.getJob(job.id);
    expect(check1!.status).toBe('pending');
    expect(check1!.attempts).toBe(1);
    expect(check1!.errorMessage).toBe('Database connection failed');

    // Wait for backoff
    await new Promise((r) => setTimeout(r, 20));

    const d2 = await backend.dequeue('sync');
    expect(d2).not.toBeNull();
    expect(d2!.attempts).toBe(2);
    await backend.fail(d2!.id, 'Permanent failure');

    const check2 = await backend.getJob(job.id);
    expect(check2!.status).toBe('dead-letter');
    expect(check2!.errorMessage).toBe('Permanent failure');

    // Explicit retry of dead-letter jobs
    const retried = await backend.retryJob('sync', job.id);
    expect(retried.length).toBe(1);
    expect(retried[0]!.status).toBe('pending');

    const d3 = await backend.dequeue('sync');
    expect(d3).not.toBeNull();
    expect(d3!.id).toBe(job.id);

    await backend.close();
  });

  it('persists data across restarts and recovers unacknowledged jobs', async () => {
    const dbPath = join(tmpdir(), `test-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      // Process 1: Enqueue jobs, dequeue one and "crash" without completing
      const backend1 = new SqliteQueueBackend(dbPath);
      const pendingJob = await backend1.enqueue('invoices', { invoiceId: 'inv-1' });
      const inFlightJob = await backend1.enqueue('invoices', { invoiceId: 'inv-2' }, { maxRetries: 3, priority: 10 });

      // Dequeue inv-2 with very short lease (10ms)
      const d = await backend1.dequeue('invoices', 10);
      expect(d!.id).toBe(inFlightJob.id);

      // Simulate crash/shutdown
      await backend1.close();

      // Wait for lease to expire
      await new Promise((r) => setTimeout(r, 30));

      // Process 2: Restart from the same SQLite file
      const backend2 = new SqliteQueueBackend(dbPath);
      const queues = await backend2.listQueues();
      expect(queues.length).toBe(1);
      expect(queues[0]!.name).toBe('invoices');
      expect(queues[0]!.total).toBe(2);

      // Recover unacknowledged work
      const recovered = await backend2.recoverUnacknowledged('invoices', 10);
      expect(recovered).toBe(1);

      const checkRecovered = await backend2.getJob(inFlightJob.id);
      expect(checkRecovered!.status).toBe('pending');
      expect(checkRecovered!.attempts).toBe(1); // kept the attempt count

      // Both jobs can now be dequeued and completed cleanly
      const next1 = await backend2.dequeue('invoices');
      expect(next1).not.toBeNull();
      await backend2.complete(next1!.id);

      const next2 = await backend2.dequeue('invoices');
      expect(next2).not.toBeNull();
      await backend2.complete(next2!.id);

      const stats = await backend2.listQueues();
      expect(stats[0]!.completed).toBe(2);
      expect(stats[0]!.pending).toBe(0);

      await backend2.close();
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {}
    }
  });

  it('prevents duplicate processing across multiple concurrent workers', async () => {
    const backend = new SqliteQueueBackend(':memory:');
    for (let i = 0; i < 20; i++) {
      await backend.enqueue('parallel-tasks', { index: i });
    }

    const processed = new Set<string>();
    const claimWorker = async () => {
      while (true) {
        const job = await backend.dequeue('parallel-tasks');
        if (!job) break;
        expect(processed.has(job.id)).toBe(false);
        processed.add(job.id);
        await backend.complete(job.id);
      }
    };

    // 4 concurrent workers
    await Promise.all([
      claimWorker(),
      claimWorker(),
      claimWorker(),
      claimWorker(),
    ]);

    expect(processed.size).toBe(20);
    const stats = await backend.listQueues();
    expect(stats[0]!.completed).toBe(20);

    await backend.close();
  });
});
