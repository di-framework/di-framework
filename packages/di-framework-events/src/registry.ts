import type { InboundRoute, OutboundRoute } from './types.ts';

// Decorator targets have heterogeneous constructors; matches GraphQL `Ctor`.
// biome-ignore lint/suspicious/noExplicitAny: see above
export type EventBridgeTarget = new (...args: any[]) => any;

export interface RegisteredEventBridge {
  target: EventBridgeTarget;
  outbound: OutboundRoute[];
  inbound: InboundRoute[];
}

/**
 * Collects classes decorated with `@EventBridge` and their `@Outbound` /
 * `@Inbound` routes. Import-time registration, same idea as HTTP/GraphQL registries.
 */
export class EventBridgeRegistry {
  private targets: Map<EventBridgeTarget, RegisteredEventBridge>;

  // Explicit constructor (rather than a field initializer) so Bun's function
  // coverage instrumentation attributes construction to a visible, coverable frame.
  constructor() {
    this.targets = new Map<EventBridgeTarget, RegisteredEventBridge>();
  }

  addTarget(target: EventBridgeTarget): RegisteredEventBridge {
    let entry = this.targets.get(target);
    if (!entry) {
      entry = { target, outbound: [], inbound: [] };
      this.targets.set(target, entry);
    }
    return entry;
  }

  addOutbound(target: EventBridgeTarget, route: OutboundRoute): void {
    this.addTarget(target).outbound.push(route);
  }

  addInbound(target: EventBridgeTarget, route: InboundRoute): void {
    this.addTarget(target).inbound.push(route);
  }

  getTargets(): EventBridgeTarget[] {
    return [...this.targets.keys()];
  }

  get(target: EventBridgeTarget): RegisteredEventBridge | undefined {
    return this.targets.get(target);
  }

  getAll(): RegisteredEventBridge[] {
    return [...this.targets.values()];
  }

  clear(): void {
    this.targets.clear();
  }
}

const globalRegistry = new EventBridgeRegistry();

export function getRegistry(): EventBridgeRegistry {
  return globalRegistry;
}

export function setRegistry(registry: EventBridgeRegistry): void {
  // Replace contents of the shared singleton so existing imports keep working.
  globalRegistry.clear();
  for (const entry of registry.getAll()) {
    const slot = globalRegistry.addTarget(entry.target);
    slot.outbound.push(...entry.outbound);
    slot.inbound.push(...entry.inbound);
  }
}

export default globalRegistry;
