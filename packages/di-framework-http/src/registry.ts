export interface EndpointMetadata {
  summary?: string;
  description?: string;
  requestBody?: any;
  responses?: Record<string, any>;
  [key: string]: any;
}

export interface RegisteredEndpoint {
  target: any;
  propertyKey: string;
  path: string;
  method: string;
  metadata: EndpointMetadata;
}

export class Registry {
  private targets: Set<any>;

  constructor() {
    this.targets = new Set();
  }

  addTarget(target: any) {
    this.targets.add(target);
  }

  getTargets() {
    return this.targets;
  }

  clear() {
    this.targets.clear();
  }
}

const GLOBAL_KEY = Symbol.for('@di-framework/http-registry');

let registry: Registry = (globalThis as any)[GLOBAL_KEY];
if (!registry) {
  registry = new Registry();
  (globalThis as any)[GLOBAL_KEY] = registry;
}

export default registry;
