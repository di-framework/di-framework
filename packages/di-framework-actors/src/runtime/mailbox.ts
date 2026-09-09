/**
 * Per-actor execution queue / mailbox.
 * Ensures complete asynchronous serialization of invocations for a single actor.
 */
import { ActorBackpressureError } from '../distributed/errors.js';

export interface ActorMailboxOptions {
  maxQueueLength?: number;
  actorId?: string;
}

export class ActorMailbox {
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly maxQueueLength?: number;
  private readonly actorId: string;
  private processing = false;

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
    if (this.maxQueueLength !== undefined && this.queue.length >= this.maxQueueLength) {
      throw new ActorBackpressureError(this.actorId, this.queue.length, this.maxQueueLength);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const nextTask = this.queue.shift();
        if (nextTask) {
          try {
            await nextTask();
          } catch {
            // Rejections are forwarded directly to the caller via enqueue Promise
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

  get isBusy(): boolean {
    return this.processing;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
