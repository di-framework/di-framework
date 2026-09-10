import { expect, test } from 'bun:test';
import { getQueueHandlerMetadata, QueueHandler, queueRegistry } from '../decorators/QueueHandler';

test('queue handler metadata and registry share both decorator entrypoints', () => {
  class Handler {}
  QueueHandler('core-queue')(Handler.prototype, 'run');
  QueueHandler('core-queue-two', { maxRetries: 7 })(Handler.prototype, 'other');
  expect(getQueueHandlerMetadata(Handler)).toHaveLength(2);
  expect(getQueueHandlerMetadata(Handler.prototype)[0]).toMatchObject({
    queueName: 'core-queue',
    options: { maxRetries: 3 },
  });
  expect(getQueueHandlerMetadata(class Empty {})).toEqual([]);
  expect(getQueueHandlerMetadata({})).toEqual([]);
  expect(queueRegistry.getForQueue('core-queue')).toHaveLength(1);
  const saved = queueRegistry.getAll();
  queueRegistry.clear();
  expect(queueRegistry.getAll()).toEqual([]);
  for (const handler of saved) queueRegistry.register(handler);
});
