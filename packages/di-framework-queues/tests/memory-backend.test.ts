import { describe, expect, it } from 'bun:test';
import { InMemoryQueueBackend } from '../src/backend/memory';

describe('InMemoryQueueBackend', () => {
  it('enqueues, dequeues, and completes jobs deterministically', async () => {
    const backend = new InMemoryQueueBackend(1000);
    const job = await backend.enqueue('orders', { orderId: 'ord-1', amount: 100 });

    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.payload).toEqual({ orderId: 'ord-1', amount: 100 });
    expect(job.attempts).toBe(0);

    const dequeued = await backend.dequeue('orders');
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(job.id);
    expect(dequeued!.status).toBe('processing');
    expect(dequeued!.attempts).toBe(1);

    await backend.complete(job.id);
    const completed = await backend.getJob(job.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBe(1000);
  });

  it('supports idempotency via idempotencyKey', async () => {
    const backend = new InMemoryQueueBackend(1000);
    const job1 = await backend.enqueue(
      'emails',
      { to: 'alice@example.com' },
      { idempotencyKey: 'welcome-alice' },
    );
    const job2 = await backend.enqueue(
      'emails',
      { to: 'alice@example.com' },
      { idempotencyKey: 'welcome-alice' },
    );

    expect(job1.id).toBe(job2.id);
    const list = await backend.listJobs('emails');
    expect(list.length).toBe(1);
  });

  it('supports advanceTime for delayed jobs', async () => {
    const backend = new InMemoryQueueBackend(1000);
    await backend.enqueue('reminders', { text: 'Drink water' }, { delayMs: 5000 });

    // Not available yet at t=1000
    let dequeued = await backend.dequeue('reminders');
    expect(dequeued).toBeNull();

    // Advance time to t=5000 (still not ready, availableAt is 6000)
    backend.advanceTime(4000);
    dequeued = await backend.dequeue('reminders');
    expect(dequeued).toBeNull();

    // Advance time past 6000 (t=6500)
    backend.advanceTime(1500);
    dequeued = await backend.dequeue('reminders');
    expect(dequeued).not.toBeNull();
    expect(dequeued!.payload.text).toBe('Drink water');
  });

  it('handles step and drain deterministically without sleeps', async () => {
    const backend = new InMemoryQueueBackend(1000);
    const processed: string[] = [];

    await backend.enqueue('tasks', 'task-1');
    await backend.enqueue('tasks', 'task-2');
    await backend.enqueue('tasks', 'task-3');

    backend.setExecutor(async (job) => {
      processed.push(job.payload);
    });

    const step1 = await backend.step('tasks');
    expect(step1).toBe(true);
    expect(processed).toEqual(['task-1']);

    const drained = await backend.drain('tasks');
    expect(drained).toBe(2);
    expect(processed).toEqual(['task-1', 'task-2', 'task-3']);

    const emptyStep = await backend.step('tasks');
    expect(emptyStep).toBe(false);
  });

  it('retries with exponential backoff and exhausts to dead-letter', async () => {
    const backend = new InMemoryQueueBackend(1000);
    const job = await backend.enqueue('flaky', { data: 'test' }, { maxRetries: 2, backoffMs: 500 });

    // Attempt 1
    const d1 = await backend.dequeue('flaky');
    expect(d1!.attempts).toBe(1);
    await backend.fail(d1!.id, new Error('Attempt 1 failed'));

    let checked = await backend.getJob(job.id);
    expect(checked!.status).toBe('pending');
    expect(checked!.availableAt).toBe(1000 + 500); // backoff 500ms

    // Not available yet
    expect(await backend.dequeue('flaky')).toBeNull();

    // Advance time past retry delay
    backend.advanceTime(600);
    const d2 = await backend.dequeue('flaky');
    expect(d2!.attempts).toBe(2);
    await backend.fail(d2!.id, new Error('Attempt 2 failed'));

    // Reached maxRetries (2), moves to dead-letter
    checked = await backend.getJob(job.id);
    expect(checked!.status).toBe('dead-letter');
    expect(checked!.errorMessage).toBe('Attempt 2 failed');

    // Explicit retry of dead-letter jobs
    const retried = await backend.retryJob('flaky', job.id);
    expect(retried.length).toBe(1);
    expect(retried[0]!.status).toBe('pending');

    const d3 = await backend.dequeue('flaky');
    expect(d3).not.toBeNull();
    expect(d3!.id).toBe(job.id);
  });

  it('recovers unacknowledged jobs after lease expiration', async () => {
    const backend = new InMemoryQueueBackend(1000);
    const job = await backend.enqueue('work', 'payload', { maxRetries: 3 });

    // Dequeued with lease timeout 5000ms
    const d1 = await backend.dequeue('work', 5000);
    expect(d1!.status).toBe('processing');

    // Before expiration: recovery does nothing
    backend.advanceTime(3000);
    let recovered = await backend.recoverUnacknowledged('work');
    expect(recovered).toBe(0);

    // After expiration: t=1000 + 3000 + 3000 = 7000 > leaseExpiresAt (6000)
    backend.advanceTime(3000);
    recovered = await backend.recoverUnacknowledged('work');
    expect(recovered).toBe(1);

    const check = await backend.getJob(job.id);
    expect(check!.status).toBe('pending');

    // Can be dequeued again
    const d2 = await backend.dequeue('work');
    expect(d2).not.toBeNull();
    expect(d2!.id).toBe(job.id);
    expect(d2!.attempts).toBe(2);
  });

  it('reports queue stats through listQueues', async () => {
    const backend = new InMemoryQueueBackend();
    await backend.enqueue('q1', 'p1');
    await backend.enqueue('q1', 'p2');
    await backend.enqueue('q1', 'p3', { maxRetries: 1 });
    await backend.enqueue('q2', 'p4');

    await backend.dequeue('q1'); // p1 is processing
    const dj2 = await backend.dequeue('q1');
    await backend.complete(dj2!.id); // p2 completed
    const dj3 = await backend.dequeue('q1');
    await backend.fail(dj3!.id, 'error'); // p3 dead-letter

    const queues = await backend.listQueues();
    const q1 = queues.find((q) => q.name === 'q1');
    const q2 = queues.find((q) => q.name === 'q2');

    expect(q1).toEqual({
      name: 'q1',
      pending: 0,
      processing: 1,
      completed: 1,
      deadLetter: 1,
      total: 3,
    });
    expect(q2).toEqual({
      name: 'q2',
      pending: 1,
      processing: 0,
      completed: 0,
      deadLetter: 0,
      total: 1,
    });
  });
});
