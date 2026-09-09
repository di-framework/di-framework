import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container } from '@di-framework/core';
import {
  ContainerQueueDispatcher,
  InMemoryQueueBackend,
  QueueWorker,
  queue,
  SqliteQueueBackend,
} from '@di-framework/queues';
import {
  discoverQueueHandlers,
  isQueueWorkerProject,
} from '../../../packages/di-framework-cli-plugin-wasmcloud/src/queues';
import { queueProjectRequirements } from '../../../packages/di-framework-cli-plugin-wasmcloud/src/wit';
import { renderWorkloadManifest } from '../../../packages/di-framework-cli-plugin-wasmcloud/src/workload';
import { AuditLogService } from '../src/AuditLogService';
import { ReceiptProcessor } from '../src/ReceiptProcessor';
import { ReceiptProducer } from '../src/ReceiptProducer';

describe('Receipt Worker Example', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('processes receipts through in-memory backend with dependency injection', async () => {
    const memory = new InMemoryQueueBackend();
    queue.setBackend(memory);

    const container = new Container();
    container.register(AuditLogService);
    container.register(ReceiptProcessor);

    const dispatcher = new ContainerQueueDispatcher(container);
    const producer = new ReceiptProducer();

    // Enqueue a receipt
    const job = await producer.submitReceipt({
      receiptId: 'rcpt_001',
      customerId: 'cust_abc',
      items: [{ description: 'Book', amount: 25 }],
      total: 25,
    });

    expect(job.status).toBe('pending');
    expect(job.queueName).toBe('receipts');

    // Step the worker dispatcher
    const processed = await memory.step('receipts', async (activeJob) => {
      await dispatcher.dispatch(activeJob);
    });

    expect(processed).toBe(true);

    const processor = container.resolve(ReceiptProcessor);
    expect(processor.processedCount).toBe(1);
    expect(processor.processedReceipts).toHaveLength(1);
    expect(processor.processedReceipts[0].receiptId).toBe('rcpt_001');

    const audit = container.resolve(AuditLogService);
    expect(audit.getRecords()).toHaveLength(1);
    expect(audit.getRecords()[0].action).toBe('receipt.processed');

    const fetched = await memory.getJob(job.id);
    expect(fetched?.status).toBe('completed');
  });

  it('enforces idempotency keys', async () => {
    const memory = new InMemoryQueueBackend();
    queue.setBackend(memory);

    const producer = new ReceiptProducer();
    const job1 = await producer.submitReceipt({
      receiptId: 'rcpt_dup',
      customerId: 'cust_1',
      items: [],
      total: 10,
    });

    const job2 = await producer.submitReceipt({
      receiptId: 'rcpt_dup',
      customerId: 'cust_1',
      items: [],
      total: 10,
    });

    expect(job1.id).toBe(job2.id);
    const queues = await memory.listQueues();
    const stats = queues.find((q) => q.name === 'receipts');
    expect(stats?.total).toBe(1);
  });

  it('retries failed jobs up to maxRetries and dead-letters exhausted jobs', async () => {
    const memory = new InMemoryQueueBackend();
    queue.setBackend(memory);

    const container = new Container();
    container.register(AuditLogService);
    container.register(ReceiptProcessor);
    const dispatcher = new ContainerQueueDispatcher(container);

    const producer = new ReceiptProducer();
    // Invalid receipt total: -1 will throw error in ReceiptProcessor
    const job = await producer.submitReceipt({
      receiptId: 'rcpt_bad',
      customerId: 'cust_err',
      items: [],
      total: -1,
    });

    // Attempt 1 fails -> scheduled for retry
    await memory.step('receipts', async (j) => dispatcher.dispatch(j));
    let current = await memory.getJob(job.id);
    expect(current?.status).toBe('pending');
    expect(current?.attempts).toBe(1);

    // Advance virtual time past backoff
    memory.advanceTime(200);
    // Attempt 2 fails
    await memory.step('receipts', async (j) => dispatcher.dispatch(j));
    current = await memory.getJob(job.id);
    expect(current?.status).toBe('pending');
    expect(current?.attempts).toBe(2);

    // Advance virtual time past backoff
    memory.advanceTime(300);
    // Attempt 3 fails -> dead lettered (maxRetries = 3)
    await memory.step('receipts', async (j) => dispatcher.dispatch(j));
    current = await memory.getJob(job.id);
    expect(current?.status).toBe('dead-letter');
    expect(current?.errorMessage).toContain('Invalid receipt data');
  });

  it('processes jobs persistently with SqliteQueueBackend across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-worker-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'test-queues.db');

    // Session 1: Enqueue job
    {
      const sqlite = new SqliteQueueBackend({ path: dbPath });
      queue.setBackend(sqlite);
      const producer = new ReceiptProducer();
      await producer.submitReceipt({
        receiptId: 'rcpt_sqlite_01',
        customerId: 'cust_sql',
        items: [{ description: 'Widget', amount: 50 }],
        total: 50,
      });
      sqlite.close();
    }

    // Session 2: Reopen backend, start QueueWorker and process
    {
      const sqlite = new SqliteQueueBackend({ path: dbPath });
      const container = new Container();
      container.register(AuditLogService);
      container.register(ReceiptProcessor);
      const dispatcher = new ContainerQueueDispatcher(container);

      const worker = new QueueWorker(sqlite, dispatcher, {
        queues: ['receipts'],
        pollIntervalMs: 50,
      });

      worker.start();
      // Wait for job to process
      let completed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const jobs = await sqlite.listJobs('receipts', { status: 'completed' });
        if (jobs.length > 0) {
          completed = true;
          break;
        }
      }

      await worker.stop();
      sqlite.close();

      expect(completed).toBe(true);
      const processor = container.resolve(ReceiptProcessor);
      expect(processor.processedCount).toBe(1);
    }
  });

  it('generates wasmCloud workload deployment manifest without HTTP service', () => {
    const exampleRoot = join(__dirname, '..');
    const project = {
      projectRoot: exampleRoot,
      entryPath: join(exampleRoot, 'src', 'index.ts'),
      applicationName: 'receipt-worker',
      witName: 'receipt-worker',
      version: '1.0.0',
      outputPath: join(exampleRoot, 'dist', 'receipt-worker.wasm'),
      applicationType: 'worker',
    };

    const handlers = discoverQueueHandlers(project as any);
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    expect(handlers[0].queueName).toBe('receipts');
    expect(isQueueWorkerProject(project as any, handlers)).toBe(true);

    const manifest = renderWorkloadManifest(
      project as any,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: {
          push: 'registry.example.com/team',
          pull: 'registry.example.com/team',
          insecure: false,
        },
      },
      'registry.example.com/team/receipt-worker:1.0.0',
      queueProjectRequirements(),
      [],
      [],
      handlers,
    );

    expect(manifest).not.toContain('kind: Service');
    expect(manifest).toContain('kind: WorkloadDeployment');
    expect(manifest).toContain('name: receipt-worker');
    expect(manifest).toContain('queueConsumers:');
    expect(manifest).toContain('- queue: "receipts"');
    expect(manifest).toContain('concurrency: 2');
    expect(manifest).toContain('maxRetries: 3');
    expect(manifest).toContain('backoffMs: 100');
    expect(manifest).toContain('timeoutMs: 5000');
  });
});
