import type { QueueHandlerMetadata, QueueHandlerOptions } from './types.js';

export const QUEUE_HANDLER_METADATA_KEY = 'di:queue_handler';

const metadataStore = new Map<any, Map<string | symbol, any>>();

function defineMetadata(key: string | symbol, value: any, target: any): void {
  if (!metadataStore.has(target)) {
    metadataStore.set(target, new Map());
  }
  metadataStore.get(target)?.set(key, value);
}

function getOwnMetadata(key: string | symbol, target: any): any {
  return metadataStore.get(target)?.get(key);
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
    const existing: QueueHandlerMetadata[] = getOwnMetadata(QUEUE_HANDLER_METADATA_KEY, target) ?? [];

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
