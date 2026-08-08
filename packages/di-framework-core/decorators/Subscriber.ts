import { defineMetadata, getOwnMetadata, SUBSCRIBER_METADATA_KEY } from '../container';

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
  return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    const map = getOwnMetadata(SUBSCRIBER_METADATA_KEY, target) || {};
    if (!map[event]) map[event] = [];
    map[event].push(propertyKey as string);
    defineMetadata(SUBSCRIBER_METADATA_KEY, map, target);
  };
}
