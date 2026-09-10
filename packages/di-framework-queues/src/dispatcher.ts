import { container as defaultContainer } from '@di-framework/core';
import { queueRegistry } from './decorators.js';
import type { Job, JobMetadata } from './types.js';

export interface QueueDispatcher {
  dispatch<T = any, R = any>(queueName: string, job: Job<T>): Promise<R>;
  dispatch<T = any, R = any>(job: Job<T>): Promise<R>;
}

export interface ContainerResolver {
  resolve<T>(token: any): T;
}

export class ContainerQueueDispatcher implements QueueDispatcher {
  private container: ContainerResolver;
  private customHandlers = new Map<string, { target: any; methodName: string; options?: any }>();

  constructor(containerResolver?: ContainerResolver) {
    this.container = containerResolver ?? (defaultContainer as ContainerResolver);
  }

  setContainer(containerResolver: ContainerResolver): void {
    this.container = containerResolver;
  }

  registerHandler(queueName: string, target: any, methodName: string, options?: any): void {
    this.customHandlers.set(queueName, { target, methodName, options });
  }

  async dispatch<T = any, R = any>(queueOrJob: string | Job<T>, maybeJob?: Job<T>): Promise<R> {
    let queueName: string;
    let job: Job<T>;
    if (typeof queueOrJob === 'string') {
      queueName = queueOrJob;
      job = maybeJob!;
    } else {
      job = queueOrJob;
      queueName = job.queueName;
    }
    let handler = this.customHandlers.get(queueName);
    if (!handler) {
      const registered = queueRegistry.getForQueue(queueName);
      if (registered.length === 1) {
        handler = registered[0];
      } else if (registered.length > 1) {
        const matched = registered.find((h) => {
          const targetClass = typeof h.target === 'function' ? h.target : h.target.constructor;
          if ('has' in this.container && typeof (this.container as any).has === 'function') {
            return (
              (this.container as any).has(targetClass) ||
              (this.container as any).has(targetClass.name)
            );
          }
          return false;
        });
        handler = matched ?? registered[registered.length - 1];
      }
    }

    if (!handler) {
      throw new Error(`No @QueueHandler registered for queue "${queueName}"`);
    }

    const targetClass =
      typeof handler.target === 'function' ? handler.target : handler.target.constructor;

    let instance: any;
    try {
      instance = this.container.resolve<any>(targetClass);
    } catch {
      try {
        instance = this.container.resolve<any>(targetClass.name);
      } catch {
        if (
          'register' in this.container &&
          typeof (this.container as any).register === 'function'
        ) {
          (this.container as any).register(targetClass);
          instance = this.container.resolve<any>(targetClass);
        } else {
          instance = new (targetClass as any)();
        }
      }
    }

    if (!instance || typeof instance[handler.methodName] !== 'function') {
      throw new Error(
        `Resolved service instance for queue "${queueName}" has no method "${handler.methodName}"`,
      );
    }

    const meta: JobMetadata = {
      jobId: job.id,
      queueName: job.queueName,
      attempts: job.attempts,
      maxRetries: job.maxRetries,
      enqueuedAt: job.enqueuedAt,
      idempotencyKey: job.idempotencyKey,
    };

    const timeoutMs = job.timeoutMs ?? handler.options?.timeoutMs ?? 30000;

    let timer: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Job ${job.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const execution = Promise.resolve(
        (instance[handler.methodName] as Function).call(instance, job.payload, meta),
      );
      return await Promise.race([execution, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }
}
