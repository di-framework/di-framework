import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Container } from '../container.js';
import {
  CronConcurrencyError,
  CronExecutionError,
  CronJobNotFoundError,
  CronRuntime,
} from '../cron/index.js';
import { Cron } from '../decorators/Cron.js';
import { Component, Container as Injectable } from '../decorators/index.js';

describe('Deployment-aware @Cron execution in core', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
    CronRuntime.reset();
  });

  afterEach(() => {
    container.clear();
    CronRuntime.reset();
  });

  it('preserves @Cron as application-facing API with options', () => {
    @Injectable()
    class ReportingService {
      @Cron('0 0 * * *', { name: 'daily-report', description: 'Daily summary' })
      generateDailyReport() {
        return 'report-generated';
      }

      @Cron(30000, { name: 'health-heartbeat' })
      heartbeat() {
        return 'ok';
      }
    }

    container.register(ReportingService);
    container.resolve(ReportingService);

    const jobs = container.getCronJobs();
    expect(jobs.length).toBe(2);

    const dailyJob = jobs.find((j) => j.jobId === 'daily-report');
    expect(dailyJob).toBeDefined();
    expect(dailyJob?.targetClassName).toBe('ReportingService');
    expect(dailyJob?.methodName).toBe('generateDailyReport');
    expect(dailyJob?.cronExpression).toBe('0 0 * * *');

    const heartbeatJob = jobs.find((j) => j.jobId === 'health-heartbeat');
    expect(heartbeatJob).toBeDefined();
    expect(heartbeatJob?.schedule).toBe(30000);
    expect(heartbeatJob?.cronExpression).toBe('* * * * *');
  });

  it('disables automatic in-component timers when scheduling is externally managed', async () => {
    let callCount = 0;

    @Injectable()
    class InComponentWorker {
      @Cron(50) // 50ms interval
      tick() {
        callCount++;
      }
    }

    // Set container to external cron mode
    container.setCronMode('external');
    expect(container.isExternalCron()).toBe(true);

    container.register(InComponentWorker);
    container.resolve(InComponentWorker);

    // Wait 150ms. In external mode, timer is NOT scheduled, callCount remains 0.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);

    // However, the job is discovered and registered in the catalog
    const jobs = container.getCronJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.methodName).toBe('tick');

    // And can be invoked manually via the private invocation interface
    const result = await container.invokeCronJob('InComponentWorker.tick');
    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(callCount).toBe(1);
  });

  it('preserves in-process timers for standalone / local mode', async () => {
    let callCount = 0;

    @Injectable()
    class LocalWorker {
      @Cron(40)
      tick() {
        callCount++;
      }
    }

    container.setCronMode('in-process');
    container.register(LocalWorker);
    container.resolve(LocalWorker);

    // Wait for in-process timer to trigger
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(callCount).toBeGreaterThanOrEqual(2);

    container.stopCronJobs();
    const countAfterStop = callCount;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(callCount).toBe(countAfterStop);
  });

  it('resolves the owning service through DI and awaits async methods', async () => {
    @Injectable()
    class DatabaseClient {
      public queryCount = 0;
      async runQuery(sql: string): Promise<string[]> {
        this.queryCount++;
        return [`result_for_${sql}`];
      }
    }

    @Injectable()
    class PruningService {
      @Component(DatabaseClient)
      private db!: DatabaseClient;

      @Cron('0 3 * * *', { name: 'nightly-prune' })
      async pruneOldRecords() {
        const rows = await this.db.runQuery('DELETE FROM logs WHERE age > 30');
        return { pruned: rows.length, dbQueries: this.db.queryCount };
      }
    }

    container.register(DatabaseClient);
    container.register(PruningService);
    container.resolve(PruningService);

    const result = await container.invokeCronJob<{ pruned: number; dbQueries: number }>(
      'nightly-prune',
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(result.result).toEqual({ pruned: 1, dbQueries: 1 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it('handles and reports execution failures without crashing caller', async () => {
    @Injectable()
    class FlakyService {
      @Cron('*/10 * * * *', { name: 'flaky-sync' })
      async syncRemote() {
        throw new Error('Connection timeout to upstream provider');
      }
    }

    container.register(FlakyService);
    container.resolve(FlakyService);

    // invoke without throwOnError (default) returns failure result
    const result = await container.invokeCronJob('flaky-sync');
    expect(result.success).toBe(false);
    expect(result.status).toBe('failure');
    expect(String(result.error)).toContain('Connection timeout to upstream provider');

    // invoke with throwOnError throws CronExecutionError
    await expect(container.invokeCronJob('flaky-sync', { throwOnError: true })).rejects.toThrow(
      CronExecutionError,
    );
  });

  it('throws CronJobNotFoundError when invoking an unknown job', async () => {
    await expect(container.invokeCronJob('non-existent-job')).rejects.toThrow(CronJobNotFoundError);
  });

  it('prevents overlapping executions when allowConcurrent is false', async () => {
    let activeExecutions = 0;
    let maxSimultaneousExecutions = 0;

    @Injectable()
    class HeavyIndexService {
      @Cron('0 * * * *', { name: 'reindex', allowConcurrent: false })
      async reindex() {
        activeExecutions++;
        maxSimultaneousExecutions = Math.max(maxSimultaneousExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, 80));
        activeExecutions--;
        return 'done';
      }
    }

    container.register(HeavyIndexService);
    container.resolve(HeavyIndexService);

    // Launch first invocation
    const promise1 = container.invokeCronJob('reindex');

    // Attempt concurrent invocation while first is in progress
    const promise2 = container.invokeCronJob('reindex');

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(res1.success).toBe(true);
    expect(res1.status).toBe('success');

    // Second execution was skipped due to concurrency guard
    expect(res2.success).toBe(false);
    expect(res2.status).toBe('skipped');
    expect(res2.reason).toContain('already running');
    expect(maxSimultaneousExecutions).toBe(1);

    // After completion, the job can run again
    const res3 = await container.invokeCronJob('reindex');
    expect(res3.success).toBe(true);
  });

  it('supports concurrent executions when allowConcurrent is explicitly true', async () => {
    let activeExecutions = 0;
    let peakExecutions = 0;

    @Injectable()
    class ConcurrentWorker {
      @Cron('0 * * * *', { name: 'parallel-fetch', allowConcurrent: true })
      async fetch() {
        activeExecutions++;
        peakExecutions = Math.max(peakExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, 60));
        activeExecutions--;
        return 'fetched';
      }
    }

    container.register(ConcurrentWorker);
    container.resolve(ConcurrentWorker);

    const [res1, res2] = await Promise.all([
      container.invokeCronJob('parallel-fetch'),
      container.invokeCronJob('parallel-fetch'),
    ]);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(peakExecutions).toBe(2);
  });

  it('cleans up jobs and resets state on container.clear() and stopCronJobs()', async () => {
    @Injectable()
    class LifecycleService {
      public runs = 0;
      @Cron(30, { name: 'lifecycle-job' })
      run() {
        this.runs++;
      }
    }

    container.register(LifecycleService);
    container.resolve(LifecycleService);

    expect(container.getCronJobs().length).toBe(1);
    expect(CronRuntime.current.getJobs().length).toBe(1);

    container.clear();

    expect(container.getCronJobs().length).toBe(0);
    expect(CronRuntime.current.getJobs().length).toBe(0);

    // Re-registration and re-resolution works cleanly
    const freshContainer = new Container();
    freshContainer.register(LifecycleService);
    freshContainer.resolve(LifecycleService);

    expect(freshContainer.getCronJobs().length).toBe(1);
    freshContainer.clear();
  });
});
