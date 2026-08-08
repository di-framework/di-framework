import { unwrapStream } from './decorators.ts';
import type {
  RpcConstructor,
  RpcFieldMetadata,
  RpcMessageMetadata,
  RpcMethodMetadata,
  RpcServiceMetadata,
} from './types.ts';

export class RpcRegistry {
  private readonly messages: Map<RpcConstructor, RpcMessageMetadata>;
  private readonly services: Map<RpcConstructor, RpcServiceMetadata>;

  // Explicit constructor (rather than field initializers) so Bun's function
  // coverage instrumentation attributes construction to a visible, coverable frame.
  constructor() {
    this.messages = new Map<RpcConstructor, RpcMessageMetadata>();
    this.services = new Map<RpcConstructor, RpcServiceMetadata>();
  }

  addMessage(target: RpcConstructor, name = target.name): RpcMessageMetadata {
    let entry = this.messages.get(target);
    if (!entry) {
      entry = { target, name, fields: [] };
      this.messages.set(target, entry);
    } else {
      entry.name = name;
    }
    return entry;
  }

  addField(target: RpcConstructor, field: RpcFieldMetadata): void {
    const entry = this.addMessage(target);
    const duplicate = entry.fields.find(
      (candidate) =>
        candidate.number === field.number || candidate.propertyKey === field.propertyKey,
    );
    if (duplicate) {
      throw new Error(
        `${entry.name}.${field.propertyKey}: duplicate RPC field name or number ${field.number}`,
      );
    }
    entry.fields.push(field);
  }

  addService(
    target: RpcConstructor,
    options: { package: string; name?: string },
  ): RpcServiceMetadata {
    let entry = this.services.get(target);
    if (!entry) {
      entry = {
        target,
        package: options.package,
        name: options.name ?? target.name,
        methods: [],
      };
      this.services.set(target, entry);
    } else {
      entry.package = options.package;
      entry.name = options.name ?? target.name;
    }
    return entry;
  }

  addMethod(target: RpcConstructor, method: RpcMethodMetadata): void {
    let entry = this.services.get(target);
    if (!entry) {
      entry = { target, package: '', name: target.name, methods: [] };
      this.services.set(target, entry);
    }
    if (
      entry.methods.some(
        (candidate) =>
          candidate.name === method.name || candidate.propertyKey === method.propertyKey,
      )
    ) {
      throw new Error(`${entry.name}.${method.name}: duplicate RPC method`);
    }
    entry.methods.push(method);
  }

  getMessage(target: RpcConstructor): RpcMessageMetadata | undefined {
    return this.messages.get(target);
  }

  getService(target: RpcConstructor): RpcServiceMetadata | undefined {
    return this.services.get(target);
  }

  getMessages(): RpcMessageMetadata[] {
    return [...this.messages.values()];
  }

  getServices(): RpcServiceMetadata[] {
    return [...this.services.values()];
  }

  /**
   * Messages reachable from a package's services: every method input/output
   * plus their transitively nested field types. Used to scope generated
   * `.proto` files and Connect descriptors to a single package.
   */
  messagesForPackage(packageName: string): RpcMessageMetadata[] {
    const roots: RpcConstructor[] = [];
    for (const service of this.services.values()) {
      if (service.package !== packageName) continue;
      for (const method of service.methods) {
        roots.push(unwrapStream(method.input()));
        if (method.output) roots.push(unwrapStream(method.output()));
      }
    }
    const seen = new Set<RpcConstructor>();
    const ordered: RpcMessageMetadata[] = [];
    const visit = (target: RpcConstructor): void => {
      if (seen.has(target)) return;
      seen.add(target);
      const meta = this.messages.get(target);
      if (!meta) return;
      ordered.push(meta);
      for (const field of meta.fields) {
        if (typeof field.type === 'function') visit(field.type());
      }
    };
    for (const root of roots) visit(root);
    return ordered;
  }

  moveService(
    source: RpcConstructor,
    target: RpcConstructor,
    options: { package: string; name?: string },
  ): RpcServiceMetadata {
    const previous = this.services.get(source);
    this.services.delete(source);
    const entry = this.addService(target, options);
    if (previous) entry.methods.push(...previous.methods);
    return entry;
  }

  findMethod(path: string): { service: RpcServiceMetadata; method: RpcMethodMetadata } | undefined {
    for (const service of this.services.values()) {
      const prefix = `${service.package}.${service.name}/`;
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      const method = service.methods.find((candidate) => candidate.name === name);
      if (method) return { service, method };
    }
    return undefined;
  }

  clear(): void {
    this.messages.clear();
    this.services.clear();
  }
}

const registry = new RpcRegistry();
export default registry;

export function getRegistry(): RpcRegistry {
  return registry;
}

export function setRegistry(next: RpcRegistry): void {
  registry.clear();
  for (const message of next.getMessages()) {
    registry.addMessage(message.target, message.name);
    for (const field of message.fields) registry.addField(message.target, field);
  }
  for (const service of next.getServices()) {
    registry.addService(service.target, service);
    for (const method of service.methods) registry.addMethod(service.target, method);
  }
}
