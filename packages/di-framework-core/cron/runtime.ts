import { type Container, useContainer } from '../container';
import type { Constructor } from '../types';
import { CronConcurrencyError, CronExecutionError, CronJobNotFoundError } from './errors';
import type {
  CronExecutionResult,
  CronInvocationContext,
  CronJobDefinition,
  CronMode,
  CronOptions,
  CronStatusReport,
} from './types';

export function normalizeCronExpression(schedule: string | number): string {
  if (typeof schedule === 'number') {
    const mins = Math.max(1, Math.round(schedule / 60000));
    return mins === 1 ? '* * * * *' : `*/${mins} * * * *`;
  }
  return schedule.trim();
}

export function formatJobId(className: string, methodName: string, customName?: string): string {
  if (customName && customName.trim() !== '') {
    return customName.trim();
  }
  return `${className}.${methodName}`;
}

export class CronRuntime {
  private static instance: CronRuntime | undefined;

  private jobs = new Map<string, CronJobDefinition>();
  private aliases = new Map<string, string>();
  private runningJobs = new Set<string>();
  private lastRuns = new Map<string, CronExecutionResult>();
  private mode: CronMode;

  constructor(initialMode?: CronMode) {
    this.mode =
      initialMode ?? (process.env.DI_CRON_MODE === 'external' ? 'external' : 'in-process');
  }

  public static get current(): CronRuntime {
    if (!CronRuntime.instance) {
      CronRuntime.instance = new CronRuntime();
    }
    return CronRuntime.instance;
  }

  public static reset(): void {
    if (CronRuntime.instance) {
      CronRuntime.instance.clear();
      CronRuntime.instance = undefined;
    }
  }

  public setMode(mode: CronMode): this {
    this.mode = mode;
    return this;
  }

  public getMode(): CronMode {
    return this.mode;
  }

  public isExternal(): boolean {
    return this.mode === 'external';
  }

  public registerJob(def: CronJobDefinition): void {
    this.jobs.set(def.jobId, def);
    const standardKey = `${def.targetClassName}.${def.methodName}`;
    if (def.jobId !== standardKey) {
      this.aliases.set(standardKey, def.jobId);
    }
    if (def.name && def.name !== def.jobId) {
      this.aliases.set(def.name, def.jobId);
    }
  }

  public getJob(jobId: string): CronJobDefinition | undefined {
    const direct = this.jobs.get(jobId);
    if (direct) return direct;
    const resolvedId = this.aliases.get(jobId);
    if (resolvedId) return this.jobs.get(resolvedId);
    return undefined;
  }

  public getJobs(): CronJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  public isJobRunning(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job) return false;
    return this.runningJobs.has(job.jobId);
  }

  public getLastRun(jobId: string): CronExecutionResult | undefined {
    const job = this.getJob(jobId);
    if (!job) return undefined;
    return this.lastRuns.get(job.jobId);
  }

  /**
   * Invokes a scheduled method by resolving the owning service through DI,
   * awaiting the method, enforcing concurrency guards, and reporting completion or failure.
   */
  public async invoke<T = any>(
    jobId: string,
    context?: Partial<CronInvocationContext> & {
      container?: Container;
      throwOnError?: boolean;
    },
  ): Promise<CronExecutionResult<T>> {
    const job = this.getJob(jobId);
    if (!job) {
      throw new CronJobNotFoundError(jobId, Array.from(this.jobs.keys()));
    }

    const allowConcurrent = job.options.allowConcurrent ?? false;
    if (!allowConcurrent && this.runningJobs.has(job.jobId)) {
      if (context?.throwOnError) {
        throw new CronConcurrencyError(job.jobId);
      }
      const now = new Date();
      const skippedResult: CronExecutionResult<T> = {
        jobId: job.jobId,
        status: 'skipped',
        success: false,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        reason: `Job "${job.jobId}" is already running and concurrency is disabled.`,
      };
      return skippedResult;
    }

    const targetContainer = context?.container ?? useContainer();
    const serviceInstance: any = targetContainer.resolve(job.targetClass);

    if (!serviceInstance || typeof serviceInstance[job.methodName] !== 'function') {
      throw new CronExecutionError(
        job.jobId,
        new Error(`Method "${job.methodName}" not found on resolved service instance`),
      );
    }

    this.runningJobs.add(job.jobId);
    const startedAt = new Date();
    const startTime = performance.now();

    try {
      let executionPromise = Promise.resolve(serviceInstance[job.methodName]());

      if (job.options.timeoutMs && job.options.timeoutMs > 0) {
        const timeoutMs = job.options.timeoutMs;
        const timeoutPromise = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Job "${job.jobId}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        executionPromise = Promise.race([executionPromise, timeoutPromise]);
      }

      const result = await executionPromise;
      const completedAt = new Date();
      const durationMs = performance.now() - startTime;

      const successResult: CronExecutionResult<T> = {
        jobId: job.jobId,
        status: 'success',
        success: true,
        startedAt,
        completedAt,
        durationMs,
        result,
      };

      this.lastRuns.set(job.jobId, successResult);
      return successResult;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = performance.now() - startTime;

      const failureResult: CronExecutionResult<T> = {
        jobId: job.jobId,
        status: 'failure',
        success: false,
        startedAt,
        completedAt,
        durationMs,
        error: error instanceof Error ? error : String(error),
      };

      this.lastRuns.set(job.jobId, failureResult);

      if (context?.throwOnError) {
        throw new CronExecutionError(job.jobId, error);
      }

      return failureResult;
    } finally {
      this.runningJobs.delete(job.jobId);
    }
  }

  public getStatusReports(): CronStatusReport[] {
    return Array.from(this.jobs.values()).map((job) => ({
      jobId: job.jobId,
      targetClassName: job.targetClassName,
      methodName: job.methodName,
      schedule: job.schedule,
      cronExpression: job.cronExpression,
      isRunning: this.runningJobs.has(job.jobId),
      allowConcurrent: job.options.allowConcurrent ?? false,
      lastRun: this.lastRuns.get(job.jobId),
    }));
  }

  public clear(): void {
    this.jobs.clear();
    this.aliases.clear();
    this.runningJobs.clear();
    this.lastRuns.clear();
  }
}
