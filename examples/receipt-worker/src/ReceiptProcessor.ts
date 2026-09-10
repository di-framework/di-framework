import { Container, Component } from '@di-framework/core/decorators';
import { QueueHandler, type JobMetadata } from '@di-framework/queues';
import { AuditLogService } from './AuditLogService.js';
import type { ReceiptJobPayload, ProcessedReceipt } from './types.js';

@Container()
export class ReceiptProcessor {
  public processedCount = 0;
  public readonly processedReceipts: ProcessedReceipt[] = [];

  constructor(@Component(AuditLogService) private readonly auditLog: AuditLogService) {}

  @QueueHandler('receipts', {
    maxRetries: 3,
    backoffMs: 100,
    timeoutMs: 5000,
    concurrency: 2,
  })
  async processReceipt(payload: ReceiptJobPayload, meta?: JobMetadata): Promise<void> {
    const data = (payload as any)?.payload ?? payload;
    if (!data || !data.receiptId || data.total < 0) {
      throw new Error(`Invalid receipt data for receipt ${data?.receiptId}`);
    }

    this.processedCount++;
    const processed: ProcessedReceipt = {
      receiptId: data.receiptId,
      customerId: data.customerId,
      total: data.total,
      processedAt: Date.now(),
    };
    this.processedReceipts.push(processed);
    this.auditLog.log('receipt.processed', {
      receiptId: data.receiptId,
      attempt: meta?.attempts ?? 1,
      total: data.total,
    });
  }
}
