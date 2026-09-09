import type { Constructor } from '../types.js';

export type CronMode = 'in-process' | 'external';

export interface CronOptions {
  /**
   * Optional stable job identifier.
   * If omitted, a stable identifier is generated (e.g. `${className}.${methodName}`).
   */
  name?: string;

  /**
   * Whether overlapping executions of this job are allowed.
   * Defaults to false (preventing overlapping runs).
   */
  allowConcurrent?: boolean;

  /**
   * Optional human-readable description of the scheduled job.
   */
  description?: string;

  /**
   * Optional maximum execution timeout in milliseconds.
   */
  timeoutMs?: number;
}

export interface CronJobDefinition {
  /**
   * Stable unique identifier for the job.
   */
  jobId: string;

  /**
   * Optional user-specified name.
   */
  name?: string;

  /**
   * The constructor of the service defining the method.
   */
  targetClass: Constructor<any>;

  /**
   * Class name of the service.
   */
  targetClassName: string;

  /**
   * Method name to invoke on the resolved service instance.
   */
  methodName: string;

  /**
   * Cron schedule: 5-field cron expression or interval in milliseconds.
   */
  schedule: string | number;

  /**
   * Normalized 5-field cron expression suitable for external schedulers.
   */
  cronExpression: string;

  /**
   * Additional job options.
   */
  options: CronOptions;

  /**
   * Cached instance if resolved, or undefined.
   */
  instance?: any;
}

export interface CronInvocationContext {
  jobId: string;
  timestamp: number;
  source?: string;
  metadata?: Record<string, any>;
}

export interface CronExecutionResult<T = any> {
  jobId: string;
  status: 'success' | 'failure' | 'skipped';
  success: boolean;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  result?: T;
  error?: Error | string;
  reason?: string;
}

export interface CronStatusReport {
  jobId: string;
  targetClassName: string;
  methodName: string;
  schedule: string | number;
  cronExpression: string;
  isRunning: boolean;
  allowConcurrent: boolean;
  lastRun?: CronExecutionResult;
}
