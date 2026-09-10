import { CRON_METADATA_KEY, defineMetadata, getOwnMetadata } from '../container';
import type { CronOptions } from './types';

export const CRON_JOB_DEFINITIONS_KEY = 'di:cron:definitions';

export interface MethodCronMetadata {
  schedule: string | number;
  options: CronOptions;
  methodName: string;
}

/**
 * Marks a method to run on a cron schedule or interval.
 *
 * In standalone / local mode, timers start automatically when the service is resolved.
 * In external scheduler mode (e.g. wasmCloud / Kubernetes external scheduler dispatch),
 * in-component timers are disabled and jobs are triggered via the private invocation interface.
 *
 * @param schedule A cron expression (5 fields) or an interval in milliseconds.
 * @param options Optional configuration including custom name, timeout, and concurrency control.
 *
 * @example
 * class BackupService {
 *   @Cron('0 2 * * *', { name: 'nightly-backup', allowConcurrent: false })
 *   async backupDatabase() {
 *     // runs nightly at 02:00
 *   }
 * }
 */
export function Cron(schedule: string | number, options?: CronOptions) {
  return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const key = propertyKey as string;

    // Preserve existing CRON_METADATA_KEY behavior (Record<string, string | number>)
    const methods = getOwnMetadata(CRON_METADATA_KEY, target) || {};
    methods[key] = schedule;
    defineMetadata(CRON_METADATA_KEY, methods, target);

    // Store extended definition
    const definitions: Record<string, MethodCronMetadata> =
      getOwnMetadata(CRON_JOB_DEFINITIONS_KEY, target) || {};
    definitions[key] = {
      schedule,
      options: options ? { ...options } : {},
      methodName: key,
    };
    defineMetadata(CRON_JOB_DEFINITIONS_KEY, definitions, target);
  };
}
