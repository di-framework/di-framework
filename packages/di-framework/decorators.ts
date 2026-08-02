/**
 * Dependency Injection Decorators
 *
 * @Container - Marks a class as injectable
 * @Component - Marks dependencies for injection (constructor parameters or properties)
 *
 * Works with SWC and TypeScript's native decorator support.
 * No external dependencies required (no reflect-metadata needed).
 */

import {
  CRON_METADATA_KEY,
  type Container as DIContainer,
  defineMetadata,
  getMetadata,
  getOwnMetadata,
  PUBLISHER_METADATA_KEY,
  SUBSCRIBER_METADATA_KEY,
  TELEMETRY_LISTENER_METADATA_KEY,
  TELEMETRY_METADATA_KEY,
  useContainer,
} from './container';

const INJECTABLE_METADATA_KEY = 'di:injectable';
const INJECT_METADATA_KEY = 'di:inject';

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
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
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
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const listeners = getOwnMetadata(TELEMETRY_LISTENER_METADATA_KEY, target) || [];
    listeners.push(propertyKey);
    defineMetadata(TELEMETRY_LISTENER_METADATA_KEY, listeners, target);
  };
}

/**
 * Options for the @Publisher decorator
 */
export interface PublisherOptions {
  /** The custom event name to emit on the container */
  event: string;
  /** When to emit relative to the method invocation. Defaults to 'after'. */
  phase?: 'before' | 'after' | 'both';
  /** Optional console logging for debug purposes. Defaults to false. */
  logging?: boolean;
}

/**
 * Marks a method to publish a custom event on invocation.
 * Useful for cross-platform event-driven architectures.
 *
 * Example:
 * @Container()
 * class UserService {
 *   @Publisher('user.created')
 *   createUser(dto: CreateUserDto) { ... }
 * }
 */
export function Publisher(optionsOrEvent: string | PublisherOptions) {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const options: PublisherOptions =
      typeof optionsOrEvent === 'string' ? { event: optionsOrEvent } : optionsOrEvent;

    const methods = getOwnMetadata(PUBLISHER_METADATA_KEY, target) || {};
    methods[propertyKey as string] = {
      event: options.event,
      phase: options.phase ?? 'after',
      logging: options.logging ?? false,
    } as PublisherOptions;
    defineMetadata(PUBLISHER_METADATA_KEY, methods, target);
  };
}

/**
 * Marks a method to subscribe to a custom event emitted on the container.
 * The decorated method will receive the published payload.
 *
 * Example:
 * @Container()
 * class AuditService {
 *   @Subscriber('user.created')
 *   onUserCreated(payload: any) { ... }
 * }
 */
export function Subscriber(event: string) {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const map = getOwnMetadata(SUBSCRIBER_METADATA_KEY, target) || {};
    if (!map[event]) map[event] = [];
    map[event].push(propertyKey as string);
    defineMetadata(SUBSCRIBER_METADATA_KEY, map, target);
  };
}

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

/**
 * Marks a class as injectable and registers it with the DI container
 *
 * @param options Configuration options for the injectable service
 *
 * @example
 * @Container()
 * class UserService {
 *   getUser(id: string) { ... }
 * }
 *
 * @example With options
 * @Container({ singleton: false })
 * class RequestScopedService {
 *   // New instance created for each resolution
 * }
 */
export function Container(options: { singleton?: boolean; container?: DIContainer } = {}) {
  return <T extends { new (...args: any[]): {} }>(ctor: T) => {
    const container = options.container ?? useContainer();
    const singleton = options.singleton ?? true;

    // Mark as injectable using our metadata store
    defineMetadata(INJECTABLE_METADATA_KEY, true, ctor);

    // Register with container
    container.register(ctor, { singleton });

    return ctor;
  };
}

/**
 * Eagerly resolves a class once at definition time.
 *
 * Useful for startup-only classes (e.g. HTTP controllers) whose constructors
 * register routes or side effects and should run before handling requests.
 */
export function Bootstrap(options: { singleton?: boolean; container?: DIContainer } = {}) {
  return <T extends { new (...args: any[]): {} }>(ctor: T) => {
    const container = options.container ?? useContainer();

    // Allow bootstrap to be used with or without @Container().
    if (!container.has(ctor)) {
      const singleton = options.singleton ?? true;
      defineMetadata(INJECTABLE_METADATA_KEY, true, ctor);
      container.register(ctor, { singleton });
    }

    container.resolve(ctor);
    return ctor;
  };
}

/**
 * Marks a constructor parameter or property for dependency injection
 *
 * Can be used on:
 * - Constructor parameters
 * - Class properties
 *
 * @param target The class to inject dependencies into. Can be a class constructor or a string identifier.
 *
 * @example Constructor parameter injection
 * @Container()
 * class UserController {
 *   constructor(@Component(UserService) userService: UserService) {}
 * }
 *
 * @example Property injection
 * @Container()
 * class UserService {
 *   @Component(DatabaseConnection)
 *   private db: DatabaseConnection;
 * }
 *
 * @example With string identifier
 * @Container()
 * class PaymentService {
 *   constructor(@Component('apiKey') apiKey: string) {}
 * }
 */
export function Component(target: any) {
  return (targetClass: object | any, propertyKey?: string | symbol, parameterIndex?: number) => {
    // Property injection
    if (propertyKey && parameterIndex === undefined) {
      // Store on both the class and its prototype to ensure it's accessible
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[propertyKey as string] = target;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);

      // Also store on the constructor if we have it
      if (targetClass.constructor && targetClass.constructor !== Object) {
        const constructorMetadata =
          getOwnMetadata(INJECT_METADATA_KEY, targetClass.constructor) || {};
        constructorMetadata[propertyKey as string] = target;
        defineMetadata(INJECT_METADATA_KEY, constructorMetadata, targetClass.constructor);
      }
    }
    // Constructor parameter injection
    else if (parameterIndex !== undefined) {
      const metadata = getOwnMetadata(INJECT_METADATA_KEY, targetClass) || {};
      metadata[`param_${parameterIndex}`] = target;
      defineMetadata(INJECT_METADATA_KEY, metadata, targetClass);
    }
  };
}

/**
 * Check if a class is marked as injectable
 */
export function isInjectable(target: any): boolean {
  return getMetadata(INJECTABLE_METADATA_KEY, target) === true;
}

/**
 * Get the container instance used by decorators
 */
export function getInjectionContainer(): DIContainer {
  return useContainer();
}
