import type { EnqueueOptions, Job, ListJobsFilter, QueueInfo } from '../types';

export interface QueueBackend {
  readonly name: string;

  enqueue<T>(queueName: string, payload: T, options?: EnqueueOptions): Promise<Job<T>>;

  dequeue(queueName: string, leaseTimeoutMs?: number): Promise<Job<any> | null>;

  complete(jobId: string): Promise<void>;

  fail(jobId: string, error: Error | string, retryAfterMs?: number): Promise<void>;

  recoverUnacknowledged(queueName?: string, leaseTimeoutMs?: number): Promise<number>;

  getJob(jobId: string): Promise<Job<any> | null>;

  listJobs(queueName: string, filter?: ListJobsFilter): Promise<Job<any>[]>;

  listQueues(): Promise<QueueInfo[]>;

  retryJob(queueName: string, jobId?: string): Promise<Job<any>[]>;

  close(): Promise<void>;
}
