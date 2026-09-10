import type { QueueBackend } from './backend/contract';
import { InMemoryQueueBackend } from './backend/memory';
import type { EnqueueOptions, Job, ListJobsFilter } from './types';

export class QueueProducer<T = any> {
  constructor(
    public readonly queueName: string,
    private readonly backendProvider: () => QueueBackend,
  ) {}

  async enqueue(payload: T, options?: EnqueueOptions): Promise<Job<T>> {
    const backend = this.backendProvider();
    return backend.enqueue(this.queueName, payload, options);
  }

  async getJob(jobId: string): Promise<Job<T> | null> {
    const backend = this.backendProvider();
    return backend.getJob(jobId);
  }

  async listJobs(filter?: ListJobsFilter): Promise<Job<T>[]> {
    const backend = this.backendProvider();
    return backend.listJobs(this.queueName, filter);
  }
}

export class QueueManager {
  private backend: QueueBackend;
  private producers = new Map<string, QueueProducer<any>>();

  constructor(backend?: QueueBackend) {
    this.backend = backend ?? new InMemoryQueueBackend();
  }

  setBackend(backend: QueueBackend): void {
    this.backend = backend;
  }

  getBackend(): QueueBackend {
    return this.backend;
  }

  get<T = any>(queueName: string): QueueProducer<T> {
    let producer = this.producers.get(queueName);
    if (!producer) {
      producer = new QueueProducer<T>(queueName, () => this.backend);
      this.producers.set(queueName, producer);
    }
    return producer;
  }

  clear(): void {
    this.producers.clear();
  }
}

export const queue = new QueueManager();
