export type JobStatus = 'pending' | 'processing' | 'completed' | 'dead-letter';

export interface Job<T = any> {
  id: string;
  queueName: string;
  payload: T;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxRetries: number;
  backoffMs: number;
  timeoutMs: number;
  enqueuedAt: number;
  availableAt: number;
  leaseExpiresAt?: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  errorMessage?: string;
  errorStack?: string;
  idempotencyKey?: string;
}

export interface EnqueueOptions {
  jobId?: string;
  idempotencyKey?: string;
  delayMs?: number;
  priority?: number;
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface JobMetadata {
  jobId: string;
  queueName: string;
  attempts: number;
  maxRetries: number;
  enqueuedAt: number;
  idempotencyKey?: string;
}

export interface QueueHandlerOptions {
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface QueueHandlerMetadata {
  queueName: string;
  methodName: string;
  target: any;
  options: QueueHandlerOptions;
}

export interface QueueInfo {
  name: string;
  pending: number;
  processing: number;
  completed: number;
  deadLetter: number;
  total: number;
}

export interface ListJobsFilter {
  status?: JobStatus | JobStatus[];
  limit?: number;
  offset?: number;
}

export interface QueueWorkerOptions {
  queues?: string[];
  concurrency?: number;
  pollIntervalMs?: number;
  leaseTimeoutMs?: number;
  recoveryIntervalMs?: number;
  shutdownTimeoutMs?: number;
}
