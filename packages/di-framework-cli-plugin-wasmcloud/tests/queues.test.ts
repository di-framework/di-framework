import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requirementsForProject } from '../src/build';
import { isQueueWorkerProject, parseQueueHandlersInFile } from '../src/queues';
import { queueProjectRequirements, renderWorldWit } from '../src/wit';
import { renderWorkloadManifest } from '../src/workload';
import { makeWorkspace } from './helpers';

const REGISTRY = {
  push: 'registry.example.com/team',
  pull: 'registry.example.com/team',
  insecure: false,
};

describe('wasmcloud queues integration', () => {
  it('parses @QueueHandler decorators from TypeScript source', () => {
    const { root } = makeWorkspace();
    const filePath = join(root, 'worker.ts');
    writeFileSync(
      filePath,
      `
import { Container } from '@di-framework/core';
import { QueueHandler } from '@di-framework/queues';

@Container()
export class ReceiptWorker {
  @QueueHandler('receipts', { concurrency: 4, maxRetries: 5, backoffMs: 200, timeoutMs: 10000 })
  async processReceipt(job: any) {
    console.log(job);
  }

  @QueueHandler('notifications')
  async sendNotification(job: any) {}
}
      `,
    );

    const handlers = parseQueueHandlersInFile(filePath);
    expect(handlers).toHaveLength(2);

    const receiptsHandler = handlers.find((h) => h.queueName === 'receipts');
    expect(receiptsHandler).toBeDefined();
    expect(receiptsHandler?.className).toBe('ReceiptWorker');
    expect(receiptsHandler?.methodName).toBe('processReceipt');
    expect(receiptsHandler?.options).toEqual({
      concurrency: 4,
      maxRetries: 5,
      backoffMs: 200,
      timeoutMs: 10000,
    });

    const notifHandler = handlers.find((h) => h.queueName === 'notifications');
    expect(notifHandler).toBeDefined();
    expect(notifHandler?.className).toBe('ReceiptWorker');
    expect(notifHandler?.methodName).toBe('sendNotification');
    expect(notifHandler?.options).toEqual({});
  });

  it('identifies queue worker projects correctly', () => {
    const { root } = makeWorkspace();
    const workerProject = {
      projectRoot: root,
      entryPath: join(root, 'src', 'index.ts'),
      applicationName: 'my-worker',
      witName: 'my-worker',
      version: '1.0.0',
      outputPath: join(root, 'dist', 'component.wasm'),
    };

    const handlers = [
      {
        className: 'Worker',
        methodName: 'handle',
        queueName: 'jobs',
        filePath: join(root, 'src', 'worker.ts'),
        options: {},
      },
    ];

    expect(isQueueWorkerProject(workerProject as any, handlers)).toBe(true);
    expect(isQueueWorkerProject(workerProject as any, [])).toBe(false);

    // If applicationType is explicitly worker:
    expect(
      isQueueWorkerProject({ ...workerProject, applicationType: 'worker' } as any, handlers),
    ).toBe(true);
  });

  it('renders WIT world with di-framework:queues/dispatch export for worker requirements', () => {
    const requirements = queueProjectRequirements();
    const wit = renderWorldWit('receipt-worker', '1.0.0', requirements);

    expect(wit).toContain('export di-framework:queues/dispatch@0.1.0;');
    expect(wit).not.toContain('wasi:http/handler');
  });

  it('renders WorkloadDeployment for worker without Kubernetes Service and with queueConsumers', () => {
    const { root } = makeWorkspace();
    const project = {
      projectRoot: root,
      entryPath: join(root, 'src', 'index.ts'),
      applicationName: 'receipt-worker',
      witName: 'receipt-worker',
      version: '1.0.0',
      outputPath: join(root, 'dist', 'receipt-worker.wasm'),
      applicationType: 'worker',
    };

    const handlers = [
      {
        className: 'ReceiptProcessor',
        methodName: 'process',
        queueName: 'receipts',
        filePath: join(root, 'src', 'ReceiptProcessor.ts'),
        options: {
          concurrency: 3,
          maxRetries: 4,
          backoffMs: 250,
          timeoutMs: 15000,
        },
      },
    ];

    const yaml = renderWorkloadManifest(
      project as any,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/receipt-worker:latest',
      queueProjectRequirements(),
      [],
      [],
      handlers,
    );

    // Should NOT contain Kubernetes Service
    expect(yaml).not.toContain('kind: Service');
    expect(yaml).not.toContain('service:');

    // Should contain WorkloadDeployment
    expect(yaml).toContain('kind: WorkloadDeployment');
    expect(yaml).toContain('name: receipt-worker');
    expect(yaml).toContain('queueConsumers:');
    expect(yaml).toContain('- queue: "receipts"');
    expect(yaml).toContain('concurrency: 3');
    expect(yaml).toContain('maxRetries: 4');
    expect(yaml).toContain('backoffMs: 250');
    expect(yaml).toContain('timeoutMs: 15000');
  });

  it('derives requirementsForProject based on queue worker detection', () => {
    const { root } = makeWorkspace();
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'worker.ts'),
      `
import { Container } from '@di-framework/core';
import { QueueHandler } from '@di-framework/queues';

@Container()
export class TestWorker {
  @QueueHandler('items')
  async run() {}
}
      `,
    );
    writeFileSync(join(srcDir, 'index.ts'), 'export * from "./worker";');

    const project = {
      projectRoot: root,
      entryPath: join(srcDir, 'index.ts'),
      applicationName: 'worker-app',
      witName: 'worker-app',
      version: '1.0.0',
      outputPath: join(root, 'dist', 'app.wasm'),
      applicationType: 'worker',
    };

    const reqs = requirementsForProject(project as any);
    const hasQueueExport = reqs.some(
      (r) => r.package === 'di-framework:queues' && r.direction === 'export',
    );
    expect(hasQueueExport).toBe(true);
    const hasHttpExport = reqs.some((r) => r.package === 'wasi:http' && r.direction === 'export');
    expect(hasHttpExport).toBe(false);
  });
});
