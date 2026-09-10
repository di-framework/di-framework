import { Container } from '@di-framework/core';
import { ContainerQueueDispatcher } from '@di-framework/queues';
import { AuditLogService } from './AuditLogService';
import { ReceiptProcessor } from './ReceiptProcessor';

export * from './AuditLogService';
export * from './ReceiptProcessor';
export * from './ReceiptProducer';
export * from './types';

export const container = new Container();
container.register(AuditLogService);
container.register(ReceiptProcessor);

export const dispatcher = new ContainerQueueDispatcher(container);
export default dispatcher;
