import { CRON_METADATA_KEY, defineMetadata, getOwnMetadata } from '../container';

/**
 * Marks a method to run on a cron schedule.
 * The schedule starts automatically when the service is resolved.
 * Jobs are stopped when container.clear() is called.
 *
 * @param schedule A cron expression (5 fields: minute hour dayOfMonth month dayOfWeek)
 *                 or an interval in milliseconds.
 *
 * @example
 * Cron('0 * * * *')   // every hour
 * Cron(30000)          // every 30 seconds
 */
export function Cron(schedule: string | number) {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const methods = getOwnMetadata(CRON_METADATA_KEY, target) || {};
    methods[propertyKey as string] = schedule;
    defineMetadata(CRON_METADATA_KEY, methods, target);
  };
}
