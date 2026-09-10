import { Container } from '@di-framework/core';
import { ContainerQueueDispatcher } from '@di-framework/queues';
import { AuditLogService } from './AuditLogService.js';
import { ReceiptProcessor } from './ReceiptProcessor.js';

export * from './types.js';
export * from './AuditLogService.js';
export * from './ReceiptProcessor.js';
export * from './ReceiptProducer.js';

export const container = new Container();
container.register(AuditLogService);
container.register(ReceiptProcessor);

export const dispatcher = new ContainerQueueDispatcher(container);
export default dispatcher;
