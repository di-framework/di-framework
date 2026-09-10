import { join } from 'node:path';
import { SqliteQueueBackend, QueueWorker, queue } from '@di-framework/queues';
import { dispatcher } from './index';
import { ReceiptProducer } from './ReceiptProducer';

const dbPath = process.env.QUEUE_DB_PATH ?? join(process.cwd(), '.di-framework', 'queues.db');
const backend = new SqliteQueueBackend({ path: dbPath });
queue.setBackend(backend);

const worker = new QueueWorker(backend, dispatcher, {
  queues: ['receipts'],
  pollIntervalMs: 500,
});

worker.start();
console.log(`Receipt worker started with SQLite backend at ${dbPath}`);

const producer = new ReceiptProducer();
await producer.submitReceipt({
  receiptId: 'rcpt_sample_001',
  customerId: 'cust_123',
  items: [{ description: 'Cloud compute credits', amount: 100 }],
  total: 100,
});
console.log('Enqueued sample receipt rcpt_sample_001');

process.on('SIGINT', async () => {
  console.log('Shutting down receipt worker...');
  await worker.stop();
  backend.close();
  process.exit(0);
});
