import type { QueueBackend } from './backend/contract';
import { queueRegistry } from './decorators';
import { ContainerQueueDispatcher, type QueueDispatcher } from './dispatcher';
import type { Job, QueueWorkerOptions } from './types';

export class QueueWorker {
  private backend: QueueBackend;
  private dispatcher: QueueDispatcher;
  private queues = new Set<string>();
  private running = false;
  private pollTimers = new Map<string, any>();
  private recoveryTimer: any;
  private inFlight = new Set<Promise<void>>();
  private options: Required<Omit<QueueWorkerOptions, 'queues'>>;

  constructor(
    backend: QueueBackend,
    dispatcher?: QueueDispatcher,
    options: QueueWorkerOptions = {},
  ) {
    for (const name of options.queues ?? []) this.queues.add(name);
    this.backend = backend;
    this.dispatcher = dispatcher ?? new ContainerQueueDispatcher();
    this.options = {
      concurrency: options.concurrency ?? 1,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      leaseTimeoutMs: options.leaseTimeoutMs ?? 30000,
      recoveryIntervalMs: options.recoveryIntervalMs ?? 10000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000,
    };
  }

  registerQueue(queueName: string): this {
    this.queues.add(queueName);
    return this;
  }

  registerAllDeclaredQueues(): this {
    for (const h of queueRegistry.getAll()) {
      this.queues.add(h.queueName);
    }
    return this;
  }

  getRegisteredQueues(): string[] {
    return [...this.queues];
  }

  isRunning(): boolean {
    return this.running;
  }

  async processNext(queueName: string): Promise<boolean> {
    const job = await this.backend.dequeue(queueName, this.options.leaseTimeoutMs);
    if (!job) return false;

    await this.executeJob(queueName, job);
    return true;
  }

  private async executeJob(queueName: string, job: Job<any>): Promise<void> {
    try {
      await this.dispatcher.dispatch(queueName, job);
      await this.backend.complete(job.id);
    } catch (err: any) {
      await this.backend.fail(job.id, err);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.queues.size === 0) {
      this.registerAllDeclaredQueues();
    }

    try {
      await this.backend.recoverUnacknowledged(undefined, this.options.leaseTimeoutMs);
    } catch {
      // ignore on initial recovery
    }

    this.recoveryTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.backend.recoverUnacknowledged(undefined, this.options.leaseTimeoutMs);
      } catch {
        // ignore periodic recovery error
      }
    }, this.options.recoveryIntervalMs);

    for (const q of this.queues) {
      this.startQueueLoop(q);
    }
  }

  private startQueueLoop(queueName: string): void {
    let active = 0;
    const handlers = queueRegistry.getForQueue(queueName);
    const queueConcurrency = handlers[0]?.options?.concurrency ?? this.options.concurrency;

    const poll = async () => {
      if (!this.running) return;

      while (this.running && active < queueConcurrency) {
        let job: Job<any> | null = null;
        try {
          job = await this.backend.dequeue(queueName, this.options.leaseTimeoutMs);
        } catch {
          break;
        }

        if (!job) break;

        active += 1;
        let finishTask!: () => void;
        const task = new Promise<void>((resolve) => {
          finishTask = resolve;
        });
        this.inFlight.add(task);

        void (async () => {
          try {
            await this.executeJob(queueName, job!);
          } finally {
            active -= 1;
            this.inFlight.delete(task);
            finishTask();
            if (this.running) {
              scheduleNext(0);
            }
          }
        })();
      }

      if (this.running) {
        scheduleNext(this.options.pollIntervalMs);
      }
    };

    const scheduleNext = (delay: number) => {
      if (!this.running) return;
      const existing = this.pollTimers.get(queueName);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        void poll();
      }, delay);
      this.pollTimers.set(queueName, timer);
    };

    scheduleNext(0);
  }

  async stop(timeoutMs?: number): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const timer of this.pollTimers.values()) {
      clearTimeout(timer);
    }
    this.pollTimers.clear();

    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    const graceMs = timeoutMs ?? this.options.shutdownTimeoutMs;
    if (this.inFlight.size > 0) {
      let timeoutId: any;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.all([...this.inFlight]), timeoutPromise]);
      clearTimeout(timeoutId);
    }
  }
}
