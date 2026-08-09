/**
 * Dependency Injection Decorators
 *
 * @Container - Marks a class as injectable
 * @Component - Marks dependencies for injection (constructor parameters or properties)
 *
 * Works with SWC and TypeScript's native decorator support.
 * No external dependencies required (no reflect-metadata needed).
 */

export { Bootstrap } from './Bootstrap.js';
export { Builder } from './Builder.js';
export {
  Component,
  Container,
  getInjectionContainer,
  isInjectable,
} from './Container.js';
export { Cron } from './Cron.js';
export { INJECT_METADATA_KEY, INJECTABLE_METADATA_KEY } from './keys.js';
export { Publisher, type PublisherOptions } from './Publisher.js';
export { Subscriber } from './Subscriber.js';
export { Telemetry, TelemetryListener, type TelemetryOptions } from './Telemetry.js';
