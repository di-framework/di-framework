import { ActorAdmissionClosedError } from '../types.js';

interface QueueItem {
  task: () => Promise<void>;
  reject: (err: Error) => void;
}

/**
 * Per-actor execution queue / mailbox.
 * Ensures complete asynchronous serialization of invocations for a single actor,
 * supports admission control, hot reload draining, failing unstarted work, and metrics inspection.
 */
import { ActorBackpressureError } from '../distributed/errors.js';

export interface ActorMailboxOptions {
  maxQueueLength?: number;
  actorId?: string;
}

export class ActorMailbox {
  private readonly queue: QueueItem[] = [];
  private readonly maxQueueLength?: number;
  private readonly actorId: string;
  private processing = false;
  private _runningCalls = 0;
  private _admissionClosed = false;

  constructor(options?: ActorMailboxOptions | number, actorId?: string) {
    if (typeof options === 'number') {
      this.maxQueueLength = options;
      this.actorId = actorId ?? 'unknown';
    } else {
      this.maxQueueLength = options?.maxQueueLength;
      this.actorId = options?.actorId ?? actorId ?? 'unknown';
    }
  }

  /**
   * Enqueues an asynchronous task to be executed sequentially.
   * Resolves or rejects with the result of the task once executed.
   * Throws ActorBackpressureError if maxQueueLength is exceeded.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this._admissionClosed) {
      return Promise.reject(
        new ActorAdmissionClosedError(
          'Actor activation is closed to new admissions (reloading or deactivated).',
        ),
      );
    }
    if (this.maxQueueLength !== undefined && this.queue.length >= this.maxQueueLength) {
      throw new ActorBackpressureError(this.actorId, this.queue.length, this.maxQueueLength);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: async () => {
          this._runningCalls++;
          try {
            const result = await task();
            resolve(result);
          } catch (err) {
            reject(err);
          } finally {
            this._runningCalls--;
          }
        },
        reject: (err: Error) => reject(err),
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const nextItem = this.queue.shift();
        if (nextItem) {
          try {
            await nextItem.task();
          } catch {
            // Errors are handled and rejected in task
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get pendingCalls(): number {
    return this.queue.length;
  }

  get runningCalls(): number {
    return this._runningCalls;
  }

  get isBusy(): boolean {
    return this.processing || this._runningCalls > 0;
  }

  get isAdmissionClosed(): boolean {
    return this._admissionClosed;
  }

  /**
   * Stops admission of new invocations to this mailbox.
   */
  stopAdmission(): void {
    this._admissionClosed = true;
  }

  /**
   * Resumes admission of new invocations.
   */
  resumeAdmission(): void {
    this._admissionClosed = false;
  }

  /**
   * Fails and cancels all unstarted queued tasks with the provided error.
   * Returns the number of canceled tasks.
   */
  failPending(error: Error): number {
    const count = this.queue.length;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        try {
          item.reject(error);
        } catch {}
      }
    }
    return count;
  }

  /**
   * Waits for the mailbox queue and active task to drain completely.
   */
  async drain(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.queue.length > 0 || this._runningCalls > 0 || this.processing) {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`ActorMailbox drain timed out after ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  clear(): void {
    const pending = this.queue.splice(0);
    for (const task of pending)
      task.reject(new Error('Actor mailbox cleared before invocation could run'));
  }
}
