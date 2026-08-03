/**
 * Dependency Injection Decorators
 *
 * @Container - Marks a class as injectable
 * @Component - Marks dependencies for injection (constructor parameters or properties)
 *
 * Works with SWC and TypeScript's native decorator support.
 * No external dependencies required (no reflect-metadata needed).
 */

export { Bootstrap } from './Bootstrap';
export { Builder } from './Builder';
export {
  Component,
  Container,
  getInjectionContainer,
  isInjectable,
} from './Container';
export { Cron } from './Cron';
export { INJECT_METADATA_KEY, INJECTABLE_METADATA_KEY } from './keys';
export { Publisher, type PublisherOptions } from './Publisher';
export { Subscriber } from './Subscriber';
export { Telemetry, TelemetryListener, type TelemetryOptions } from './Telemetry';
