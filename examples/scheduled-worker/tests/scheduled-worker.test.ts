import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { discoverScheduledJobs, renderWorkloadManifest } from '@di-framework/cli-plugin-wasmcloud';
import { Container, CronRuntime } from '@di-framework/core';
import { AuditLogger } from '../src/services/AuditLogger.js';
import { DatabaseRepository } from '../src/services/DatabaseRepository.js';
import { type MaintenanceReport, MaintenanceService } from '../src/services/MaintenanceService.js';

describe('Scheduled Worker Example (@Cron in wasmCloud)', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
    CronRuntime.reset();
  });

  afterEach(() => {
    container.clear();
    CronRuntime.reset();
  });

  it('demonstrates an existing @Cron method running with DI dependencies', async () => {
    container.register(AuditLogger);
    container.register(DatabaseRepository);
    container.register(MaintenanceService);

    // Resolve through DI
    const maintenance = container.resolve(MaintenanceService);
    expect(maintenance.db).toBeDefined();
    expect(maintenance.audit).toBeDefined();

    // Trigger scheduled method via manual invocation interface without real-time delays
    const result = await container.invokeCronJob<MaintenanceReport>('nightly-prune');

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(result.result?.job).toBe('nightly-prune');
    expect(result.result?.pruned).toBe(2); // 2 expired records deleted
    expect(result.result?.auditCount).toBe(1); // Audit record logged

    // Verify dependencies were invoked
    expect(maintenance.db.queryCount).toBe(1);
    expect(maintenance.audit.getLogCount()).toBe(1);
    expect(maintenance.audit.logs[0]?.action).toBe('prune_expired_sessions');
    maintenance.audit.clear();
    expect(maintenance.audit.getLogCount()).toBe(0);
    expect(maintenance.audit.logs).toEqual([]);
  });

  it('runs without exposed endpoint and suppresses in-component timers in external mode', async () => {
    container.setCronMode('external');
    expect(container.isExternalCron()).toBe(true);
    expect(container.getCronMode()).toBe('external');

    container.register(AuditLogger);
    container.register(DatabaseRepository);
    container.register(MaintenanceService);
    container.resolve(MaintenanceService);

    // Initial state: 0 queries
    const db = container.resolve(DatabaseRepository);
    expect(db.queryCount).toBe(0);

    // Wait a brief period: in external mode, timers are suppressed so queries remain 0
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(db.queryCount).toBe(0);

    // When dispatched externally via the invocation interface, it executes
    const result = await container.invokeCronJob('partition-rebalance');
    expect(result.success).toBe(true);
    expect(db.queryCount).toBe(1);
  });

  it('covers schedule discovery for the scheduled worker project', () => {
    const projectRoot = join(import.meta.dir, '..');
    const jobs = discoverScheduledJobs(projectRoot);

    expect(jobs.length).toBe(2);

    const pruneJob = jobs.find((j) => j.jobId === 'nightly-prune');
    expect(pruneJob).toBeDefined();
    expect(pruneJob?.schedule).toBe('0 2 * * *');
    expect(pruneJob?.cronExpression).toBe('0 2 * * *');
    expect(pruneJob?.allowConcurrent).toBe(false);

    const rebalanceJob = jobs.find((j) => j.jobId === 'partition-rebalance');
    expect(rebalanceJob).toBeDefined();
    expect(rebalanceJob?.schedule).toBe('*/15 * * * *');
    expect(rebalanceJob?.cronExpression).toBe('*/15 * * * *');
  });

  it('covers dispatch, overlapping rejection, and restart semantics', async () => {
    container.register(AuditLogger);
    container.register(DatabaseRepository);
    container.register(MaintenanceService);
    container.resolve(MaintenanceService);

    // Overlapping execution test:
    // Temporarily simulate a long-running execution of partition-rebalance
    const maintenance = container.resolve(MaintenanceService);
    const originalRebalance = maintenance.rebalanceStorage.bind(maintenance);

    let resolveActiveRun: (() => void) | undefined;
    maintenance.rebalanceStorage = async () => {
      await new Promise<void>((resolve) => {
        resolveActiveRun = resolve;
      });
      return { rebalanced: 99 };
    };

    // First invocation starts and hangs until resolveActiveRun is called
    const run1Promise = container.invokeCronJob('partition-rebalance');

    // Second invocation while run1 is active
    const run2Promise = container.invokeCronJob('partition-rebalance');

    const run2 = await run2Promise;
    expect(run2.success).toBe(false);
    expect(run2.status).toBe('skipped');
    expect(run2.reason).toContain('already running');

    // Complete run1
    resolveActiveRun?.();
    const run1 = await run1Promise;
    expect(run1.success).toBe(true);
    expect(run1.result).toEqual({ rebalanced: 99 });

    // Restart / subsequent invocation now succeeds
    maintenance.rebalanceStorage = originalRebalance;
    const run3 = await container.invokeCronJob('partition-rebalance');
    expect(run3.success).toBe(true);
  });

  it('covers reload and cleanup semantics', async () => {
    container.register(AuditLogger);
    container.register(DatabaseRepository);
    container.register(MaintenanceService);
    container.resolve(MaintenanceService);

    expect(container.getCronJobs().length).toBe(2);

    // Clear / reload
    container.clear();
    expect(container.getCronJobs().length).toBe(0);

    // Fresh registration works after reload
    container.register(AuditLogger);
    container.register(DatabaseRepository);
    container.register(MaintenanceService);
    container.resolve(MaintenanceService);

    expect(container.getCronJobs().length).toBe(2);
    const res = await container.invokeCronJob('nightly-prune');
    expect(res.success).toBe(true);
  });

  it('generates deployment manifest without exposed endpoint and with external scheduler dispatch', () => {
    const projectRoot = join(import.meta.dir, '..');
    const jobs = discoverScheduledJobs(projectRoot);

    const project = {
      applicationName: 'scheduled-worker',
      witName: 'scheduled-worker',
      configPath: join(projectRoot, 'di-framework.config.json'),
      entryPath: join(projectRoot, 'src/index.ts'),
      outputPath: join(projectRoot, 'dist/scheduled-worker.wasm'),
      bindingsPath: undefined,
      bindingsConfigured: false,
      bindingsRelative: 'src/bindings.ts',
      projectRoot,
      version: '1.0.0',
      ingress: false, // No HTTP ingress!
    };

    const connection = {
      target: 'prod',
      namespace: 'workers',
      kubeconfig: '/mock/kubeconfig',
      registry: { host: 'oci.internal' },
    };

    const manifest = renderWorkloadManifest(
      project,
      connection as any,
      'oci.internal/scheduled-worker:v1',
      [],
      [],
      undefined,
      jobs,
    );

    // Verifies: Method runs without exposed endpoint
    expect(manifest).not.toContain('kind: Service');
    expect(manifest).not.toContain('targetPort: 80');

    // Verifies: WorkloadDeployment suppresses in-component timers in external mode
    expect(manifest).toContain('kind: WorkloadDeployment');
    expect(manifest).toContain('DI_CRON_MODE');
    expect(manifest).toContain('"external"');

    // Verifies: External scheduler dispatch configuration generated
    expect(manifest).toContain('apiVersion: batch/v1');
    expect(manifest).toContain('kind: CronJob');
    expect(manifest).toContain('name: scheduled-worker-nightly-prune');
    expect(manifest).toContain('name: scheduled-worker-partition-rebalance');
    expect(manifest).toContain('schedule: "0 2 * * *"');
    expect(manifest).toContain('schedule: "*/15 * * * *"');
  });
});
