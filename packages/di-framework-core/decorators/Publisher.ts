import { defineMetadata, getOwnMetadata, PUBLISHER_METADATA_KEY } from '../container';

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
