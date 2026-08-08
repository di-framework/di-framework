import {
  defineMetadata,
  getOwnMetadata,
  TELEMETRY_LISTENER_METADATA_KEY,
  TELEMETRY_METADATA_KEY,
} from '../container';

/**
 * Options for the @Telemetry decorator
 */
export interface TelemetryOptions {
  /**
   * Whether to log the telemetry event to the console.
   * Defaults to false.
   */
  logging?: boolean;
}

/**
 * Marks a method for telemetry tracking.
 * When called, it will emit a 'telemetry' event on the container.
 * Compatible with async and sync methods.
 *
 * @param options Configuration options for telemetry
 */
export function Telemetry(options: TelemetryOptions = {}) {
  return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const methods = getOwnMetadata(TELEMETRY_METADATA_KEY, target) || {};
    methods[propertyKey as string] = options;
    defineMetadata(TELEMETRY_METADATA_KEY, methods, target);
  };
}

/**
 * Marks a method as a listener for telemetry events.
 * The method will be automatically registered to the container's 'telemetry' event.
 */
export function TelemetryListener() {
  return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const listeners = getOwnMetadata(TELEMETRY_LISTENER_METADATA_KEY, target) || [];
    listeners.push(propertyKey);
    defineMetadata(TELEMETRY_LISTENER_METADATA_KEY, listeners, target);
  };
}
