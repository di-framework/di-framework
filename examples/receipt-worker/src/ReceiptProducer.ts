import { queue, type Job, type QueueProducer } from '@di-framework/queues';
import type { ReceiptJobPayload } from './types.js';

export class ReceiptProducer {
  private readonly producer: QueueProducer<ReceiptJobPayload>;

  constructor() {
    this.producer = queue.get<ReceiptJobPayload>('receipts');
  }

  async submitReceipt(
    payload: ReceiptJobPayload,
    idempotencyKey?: string,
  ): Promise<Job<ReceiptJobPayload>> {
    return this.producer.enqueue(payload, {
      idempotencyKey: idempotencyKey ?? payload.receiptId,
      maxRetries: 3,
      backoffMs: 100,
    });
  }
}
