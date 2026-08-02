/**
 * Type Definitions and Utilities for the DI Framework
 *
 * Provides interfaces and utility types for building services
 */

/**
 * Represents a service class constructor
 */
export type ServiceClass<T> = new (...args: any[]) => T;

/**
 * Represents a factory function that creates a service
 */
export type ServiceFactory<T> = () => T;

/**
 * Service registration options
 */
export interface InjectionOptions {
  /**
   * Whether this service should be a singleton (default: true)
   * Singleton: same instance returned for each resolution
   * Transient: new instance created for each resolution
   */
  singleton?: boolean;
}

/**
 * Service with lifecycle methods
 */
export interface ILifecycleService {
  /**
   * Called after the service is created
   */
  onInit?(): void;

  /**
   * Called before the service is destroyed
   */
  onDestroy?(): void;

  /**
   * Called to set environment variables
   */
  setEnv?(env: Record<string, any>): void;

  /**
   * Called to set execution context
   */
  setCtx?(context: any): void;
}

/**
 * Error thrown when DI resolution fails
 */
export class DIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DIError';
  }
}

/**
 * Error thrown when circular dependency is detected
 */
export class CircularDependencyError extends DIError {
  constructor(message: string) {
    super(message);
    this.name = 'CircularDependencyError';
  }
}

/**
 * Error thrown when service is not registered
 */
export class ServiceNotFoundError extends DIError {
  constructor(serviceName: string) {
    super(`Service '${serviceName}' is not registered in the DI container`);
    this.name = 'ServiceNotFoundError';
  }
}

/**
 * Type-safe service class identity
 *
 * Use this to ensure type safety when working with service classes
 *
 * @example
 * type UserServiceId = ServiceId<UserService>;
 * const serviceId: UserServiceId = UserService;
 */
export type ServiceId<T> = ServiceClass<T>;

/**
 * Utility type to extract the constructor parameters of a service
 *
 * @example
 * type UserServiceDeps = ConstructorParameters<typeof UserService>;
 */
export type ServiceDependencies<T> =
  T extends ServiceClass<infer U> ? ConstructorParameters<ServiceClass<U>> : never;

/**
 * Utility type to make all properties of a service optional
 *
 * @example
 * @Container()
 * class MyService implements PartialService<MyService> {
 *   optionalDependency?: SomeService;
 * }
 */
export type PartialService<T> = Partial<T>;

/**
 * Utility to create a service instance with mocked dependencies
 *
 * @example
 * const mockUserService = new MockService<UserService>({
 *   database: mockDb,
 *   logger: mockLogger
 * });
 */
export type MockServiceOptions<T> = {
  [K in keyof T]?: T[K];
};

/**
 * Represents a resolvable service in the container
 */
export type Resolvable = ServiceClass<any> | string;

/**
 * Configuration for the DI container
 */
export interface ContainerConfig {
  /**
   * Whether to throw on unregistered services (default: true)
   */
  throwOnUnregistered?: boolean;

  /**
   * Whether to detect circular dependencies (default: true)
   */
  detectCircularDependencies?: boolean;

  /**
   * Maximum recursion depth for dependency resolution (default: 100)
   */
  maxResolutionDepth?: number;
}

/**
 * Service metadata stored in the container
 */
export interface ServiceMetadata<T = any> {
  type: ServiceClass<T> | ServiceFactory<T>;
  singleton: boolean;
  instance?: T;
  dependencies?: string[];
  createdAt?: Date;
}

/**
 * Result of resolving a service
 */
export interface ResolutionResult<T = any> {
  service: T;
  serviceClass: ServiceClass<T>;
  isSingleton: boolean;
  resolutionTimeMs: number;
}

/**
 * Information about a registered service
 */
export interface ServiceInfo {
  name: string;
  isSingleton: boolean;
  dependencies: string[];
  hasInstance: boolean;
}

/**
 * Generic service base class with lifecycle support
 *
 * @example
 * @Container()
 * export class MyService extends BaseService {
 *   onInit() {
 *     console.log('Service initialized');
 *   }
 * }
 */
export abstract class BaseService implements ILifecycleService {
  protected logger: ILogger = new ConsoleLogger();

  onInit?(): void;
  onDestroy?(): void;
  setEnv?(env: Record<string, any>): void;
  setCtx?(context: any): void;

  protected log(message: string): void {
    this.logger.log(message);
  }

  protected error(message: string): void {
    this.logger.error(message);
  }
}

/**
 * Logger interface for services
 */
export interface ILogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/**
 * Console-based logger implementation
 */
export class ConsoleLogger implements ILogger {
  log(message: string): void {
    console.log(`[LOG] ${message}`);
  }

  error(message: string): void {
    console.error(`[ERROR] ${message}`);
  }

  warn(message: string): void {
    console.warn(`[WARN] ${message}`);
  }

  debug(message: string): void {
    console.debug(`[DEBUG] ${message}`);
  }
}

/**
 * Utility functions for working with services
 */
export namespace ServiceUtils {
  /**
   * Check if an object is a service class
   */
  export function isServiceClass(obj: any): obj is ServiceClass<any> {
    return typeof obj === 'function' && obj.prototype;
  }

  /**
   * Check if an object is a factory function
   */
  export function isFactory(obj: any): obj is ServiceFactory<any> {
    return typeof obj === 'function' && !isServiceClass(obj);
  }

  /**
   * Get the service name
   */
  export function getServiceName(service: Resolvable): string {
    if (typeof service === 'string') {
      return service;
    }
    return service.name;
  }

  /**
   * Create a mock service for testing
   */
  export function createMockService<T>(overrides: Partial<T> = {}): Partial<T> {
    return overrides;
  }
}

/**
 * Decorator factory for creating custom decorators
 *
 * @example
 * export function Cached(ttl: number = 60000) {
 *   return function (
 *     target: any,
 *     propertyKey: string,
 *     descriptor: PropertyDescriptor
 *   ) {
 *     const originalMethod = descriptor.value;
 *     const cache = new Map<string, { data: any; time: number }>();
 *
 *     descriptor.value = function (...args: any[]) {
 *       const key = JSON.stringify(args);
 *       const cached = cache.get(key);
 *       const now = Date.now();
 *
 *       if (cached && now - cached.time < ttl) {
 *         return cached.data;
 *       }
 *
 *       const result = originalMethod.apply(this, args);
 *       cache.set(key, { data: result, time: now });
 *       return result;
 *     };
 *
 *     return descriptor;
 *   };
 * }
 */
export function createDecorator<T extends (...args: any[]) => any>(decorator: T): T {
  return decorator;
}
