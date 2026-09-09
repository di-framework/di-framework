/**
 * Per-actor execution queue / mailbox.
 * Ensures complete asynchronous serialization of invocations for a single actor.
 */
export class ActorMailbox {
  private readonly queue: Array<{ run: () => Promise<void>; reject: (error: Error) => void }> = [];
  private processing = false;

  /**
   * Enqueues an asynchronous task to be executed sequentially.
   * Resolves or rejects with the result of the task once executed.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        reject,
        run: async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (err) {
            reject(err);
          }
        },
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
            await nextTask.run();
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
    const pending = this.queue.splice(0);
    for (const task of pending)
      task.reject(new Error('Actor mailbox cleared before invocation could run'));
  }
}
