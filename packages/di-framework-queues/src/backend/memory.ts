import { queueRegistry } from '../decorators.js';
import type { EnqueueOptions, Job, ListJobsFilter, QueueInfo } from '../types.js';
import type { QueueBackend } from './contract.js';

export class InMemoryQueueBackend implements QueueBackend {
  readonly name = 'in-memory';
  private jobs = new Map<string, Job<any>>();
  private virtualTime: number = Date.now();
  private nextId = 1;
  private executor?: (job: Job<any>) => Promise<void>;

  constructor(initialTime?: number) {
    if (initialTime !== undefined) {
      this.virtualTime = initialTime;
    }
  }

  now(): number {
    return this.virtualTime;
  }

  advanceTime(ms: number): void {
    if (ms < 0) throw new Error('Cannot advance time backwards');
    this.virtualTime += ms;
  }

  setExecutor(executor: (job: Job<any>) => Promise<void>): void {
    this.executor = executor;
  }

  async enqueue<T>(queueName: string, payload: T, options?: EnqueueOptions): Promise<Job<T>> {
    const enqueuedAt = this.now();
    const idempotencyKey = options?.idempotencyKey;

    if (idempotencyKey !== undefined) {
      for (const existing of this.jobs.values()) {
        if (
          existing.queueName === queueName &&
          existing.idempotencyKey === idempotencyKey &&
          existing.status !== 'dead-letter'
        ) {
          return { ...existing };
        }
      }
    }

    const id =
      options?.jobId ??
      `job_${enqueuedAt}_${this.nextId++}_${Math.random().toString(36).substring(2, 9)}`;

    const defaults = queueRegistry.getForQueue(queueName)[0]?.options;
    const job: Job<T> = {
      id,
      queueName,
      payload,
      status: 'pending',
      priority: options?.priority ?? 0,
      attempts: 0,
      maxRetries: options?.maxRetries ?? defaults?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? defaults?.backoffMs ?? 1000,
      timeoutMs: options?.timeoutMs ?? defaults?.timeoutMs ?? 30000,
      enqueuedAt,
      availableAt: enqueuedAt + (options?.delayMs ?? 0),
      idempotencyKey,
    };

    this.jobs.set(id, job);
    return { ...job };
  }

  async dequeue(queueName: string, leaseTimeoutMs = 30000): Promise<Job<any> | null> {
    const now = this.now();
    const eligible: Job<any>[] = [];

    for (const job of this.jobs.values()) {
      if (job.queueName === queueName && job.status === 'pending' && job.availableAt <= now) {
        eligible.push(job);
      }
    }

    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
      return a.enqueuedAt - b.enqueuedAt;
    });

    const chosen = eligible[0]!;
    chosen.status = 'processing';
    chosen.attempts += 1;
    chosen.startedAt = now;
    chosen.leaseExpiresAt = now + leaseTimeoutMs;

    return { ...chosen };
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'completed';
    job.completedAt = this.now();
    job.leaseExpiresAt = undefined;
  }

  async fail(jobId: string, error: Error | string, retryAfterMs?: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.failedAt = this.now();
    job.errorMessage = error instanceof Error ? error.message : String(error);
    job.errorStack = error instanceof Error ? error.stack : undefined;
    job.leaseExpiresAt = undefined;

    if (job.attempts < job.maxRetries) {
      job.status = 'pending';
      const backoff =
        retryAfterMs !== undefined
          ? retryAfterMs
          : Math.min(job.backoffMs * 2 ** (job.attempts - 1), 60000);
      job.availableAt = this.now() + backoff;
    } else {
      job.status = 'dead-letter';
    }
  }

  async recoverUnacknowledged(queueName?: string, leaseTimeoutMs = 30000): Promise<number> {
    const now = this.now();
    let recovered = 0;

    for (const job of this.jobs.values()) {
      if (queueName && job.queueName !== queueName) continue;

      if (job.status === 'processing') {
        const leaseExpired = job.leaseExpiresAt === undefined || job.leaseExpiresAt <= now;
        if (leaseExpired) {
          job.leaseExpiresAt = undefined;
          if (job.attempts >= job.maxRetries) {
            job.status = 'dead-letter';
          } else {
            job.status = 'pending';
            job.availableAt = now;
          }
          recovered += 1;
        }
      }
    }

    return recovered;
  }

  async getJob(jobId: string): Promise<Job<any> | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async listJobs(queueName: string, filter?: ListJobsFilter): Promise<Job<any>[]> {
    const results: Job<any>[] = [];
    const statusFilter = filter?.status
      ? Array.isArray(filter.status)
        ? new Set(filter.status)
        : new Set([filter.status])
      : undefined;

    for (const job of this.jobs.values()) {
      if (job.queueName !== queueName) continue;
      if (statusFilter && !statusFilter.has(job.status)) continue;
      results.push({ ...job });
    }

    results.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  async listQueues(): Promise<QueueInfo[]> {
    const stats = new Map<
      string,
      { pending: number; processing: number; completed: number; deadLetter: number; total: number }
    >();

    for (const job of this.jobs.values()) {
      let q = stats.get(job.queueName);
      if (!q) {
        q = { pending: 0, processing: 0, completed: 0, deadLetter: 0, total: 0 };
        stats.set(job.queueName, q);
      }
      q.total += 1;
      if (job.status === 'pending') q.pending += 1;
      else if (job.status === 'processing') q.processing += 1;
      else if (job.status === 'completed') q.completed += 1;
      else if (job.status === 'dead-letter') q.deadLetter += 1;
    }

    return [...stats.entries()].map(([name, s]) => ({
      name,
      ...s,
    }));
  }

  async retryJob(queueName: string, jobId?: string): Promise<Job<any>[]> {
    const retried: Job<any>[] = [];
    const now = this.now();

    for (const job of this.jobs.values()) {
      if (job.queueName !== queueName) continue;
      if (jobId !== undefined && job.id !== jobId) continue;

      if (job.status === 'dead-letter') {
        job.status = 'pending';
        job.availableAt = now;
        job.errorMessage = undefined;
        job.errorStack = undefined;
        retried.push({ ...job });
      }
    }

    return retried;
  }

  async step(queueName?: string, handler?: (job: Job<any>) => Promise<void>): Promise<boolean> {
    const exec = handler ?? this.executor;
    if (!exec) {
      throw new Error('InMemoryQueueBackend.step requires a handler or registered executor');
    }

    let queuesToTry: string[] = [];
    if (queueName) {
      queuesToTry = [queueName];
    } else {
      const qNames = new Set<string>();
      for (const job of this.jobs.values()) {
        if (job.status === 'pending' && job.availableAt <= this.now()) {
          qNames.add(job.queueName);
        }
      }
      queuesToTry = [...qNames];
    }

    for (const q of queuesToTry) {
      const job = await this.dequeue(q);
      if (job) {
        try {
          await exec(job);
          await this.complete(job.id);
        } catch (err: any) {
          await this.fail(job.id, err);
        }
        return true;
      }
    }

    return false;
  }

  async drain(
    queueName?: string,
    maxSteps = 1000,
    handler?: (job: Job<any>) => Promise<void>,
  ): Promise<number> {
    let count = 0;
    while (count < maxSteps) {
      const stepped = await this.step(queueName, handler);
      if (!stepped) break;
      count += 1;
    }
    return count;
  }

  async close(): Promise<void> {
    this.jobs.clear();
  }
}
