import { defineMetadata, getOwnMetadata, QUEUE_HANDLER_METADATA_KEY } from '../container.js';

export interface QueueHandlerOptions {
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface QueueHandlerMetadata {
  queueName: string;
  methodName: string;
  options: QueueHandlerOptions;
}

/**
 * Marks a method as a durable queue message handler.
 *
 * @param queueName The name of the queue to handle
 * @param options Queue processing options (retries, backoff, timeout, concurrency)
 */
export function QueueHandler(queueName: string, options: QueueHandlerOptions = {}) {
  return (target: any, propertyKey: string | symbol, _descriptor?: PropertyDescriptor) => {
    const list: QueueHandlerMetadata[] = getOwnMetadata(QUEUE_HANDLER_METADATA_KEY, target) || [];
    list.push({
      queueName,
      methodName: String(propertyKey),
      options,
    });
    defineMetadata(QUEUE_HANDLER_METADATA_KEY, list, target);
  };
}
