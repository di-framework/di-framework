import { defineMetadata, getOwnMetadata, QUEUE_HANDLER_METADATA_KEY } from '../container.js';

export { QUEUE_HANDLER_METADATA_KEY };

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

class QueueHandlerRegistry {
  private handlers: QueueHandlerMetadata[] = [];

  register(handler: QueueHandlerMetadata): void {
    this.handlers.push(handler);
  }

  getForQueue(queueName: string): QueueHandlerMetadata[] {
    return this.handlers.filter((h) => h.queueName === queueName);
  }

  getAll(): QueueHandlerMetadata[] {
    return [...this.handlers];
  }

  clear(): void {
    this.handlers = [];
  }
}

export const queueRegistry = new QueueHandlerRegistry();

export function getQueueHandlerMetadata(target: any): QueueHandlerMetadata[] {
  const meta = getOwnMetadata(QUEUE_HANDLER_METADATA_KEY, target);
  if (meta) return meta;
  if (target?.prototype) {
    return getOwnMetadata(QUEUE_HANDLER_METADATA_KEY, target.prototype) ?? [];
  }
  return [];
}

export function QueueHandler(queueName: string, options: QueueHandlerOptions = {}) {
  return (target: any, propertyKey: string | symbol, _descriptor?: PropertyDescriptor) => {
    const keyStr = String(propertyKey);
    const existing: QueueHandlerMetadata[] =
      getOwnMetadata(QUEUE_HANDLER_METADATA_KEY, target) ?? [];

    const meta: QueueHandlerMetadata = {
      queueName,
      methodName: keyStr,
      target,
      options: {
        maxRetries: options.maxRetries ?? 3,
        backoffMs: options.backoffMs ?? 1000,
        timeoutMs: options.timeoutMs ?? 30000,
        concurrency: options.concurrency ?? 1,
      },
    };

    existing.push(meta);
    defineMetadata(QUEUE_HANDLER_METADATA_KEY, existing, target);
    queueRegistry.register(meta);
  };
}
