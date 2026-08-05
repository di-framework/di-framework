import type { FrameKind } from './core/frame.ts';

export interface SocketHandlerMeta {
  kind: 'connect' | 'message' | 'close' | 'error';
  method: string | symbol;
  /** Optional message type filter for JSON `{ type }` payloads (text frames). */
  type?: string;
  /** Optional WebSocket/application frame kind filter. */
  frame?: FrameKind | 'any';
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous constructors
export type GatewayCtor = new (...args: any[]) => any;

export interface SocketGatewayEntry {
  target: GatewayCtor;
  handlers: SocketHandlerMeta[];
}

/**
 * Collects `@SocketGateway` classes and their `@OnConnect` / `@OnMessage` / … methods.
 * Same role as the HTTP and events registries.
 */
export class SocketGatewayRegistry {
  private readonly entries = new Map<GatewayCtor, SocketGatewayEntry>();

  addTarget(target: GatewayCtor): void {
    if (!this.entries.has(target)) {
      this.entries.set(target, { target, handlers: [] });
    }
  }

  addHandler(target: GatewayCtor, meta: SocketHandlerMeta): void {
    this.addTarget(target);
    this.entries.get(target)!.handlers.push(meta);
  }

  get(target: GatewayCtor): SocketGatewayEntry | undefined {
    return this.entries.get(target);
  }

  all(): SocketGatewayEntry[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }
}

const registry = new SocketGatewayRegistry();

export function getRegistry(): SocketGatewayRegistry {
  return registry;
}

export function setRegistry(next: SocketGatewayRegistry): void {
  // tests can isolate registration
  registry.clear();
  for (const e of next.all()) {
    registry.addTarget(e.target);
    for (const h of e.handlers) registry.addHandler(e.target, h);
  }
}

export default registry;
