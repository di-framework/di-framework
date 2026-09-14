import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';

export const WORKLOAD_KEY = 'di:workload';
export const WORKLOAD_COMPONENT_KEY = 'di:workload-component';
export const WORKLOAD_SERVICE_KEY = 'di:workload-service';

export type WorkloadFetchHandler = (request: Request) => Response | Promise<Response>;
export type WorkloadRunHandler = () => Promise<void>;

export type WorkloadMetadata = {
  name: string;
};

export type WorkloadComponentOptions = {
  workload: string;
  /** Public HTTP path this component claims. Ingress is the union of routes in the namespace. */
  route?: string;
};

export type WorkloadServiceOptions = {
  workload: string;
};

function requireName(kind: string, name: string): string {
  if (!name.trim()) {
    throw new Error(`${kind} name is required`);
  }
  return name;
}

/**
 * Names a colocation namespace. Not an HTTP gateway and not a deployable.
 * Components and services join it via {@link WorkloadComponent} / {@link WorkloadService}.
 */
export function Workload(name: string) {
  const metadata: WorkloadMetadata = { name: requireName('Workload', name) };
  return <T extends object>(target: T): T => {
    defineMetadata(WORKLOAD_KEY, metadata, target);
    return target;
  };
}

function componentMetadata(options: WorkloadComponentOptions): WorkloadComponentOptions {
  const workload = requireName('WorkloadComponent', options.workload);
  const route = options.route?.trim();
  if (route !== undefined && route !== '' && !route.startsWith('/')) {
    throw new Error('WorkloadComponent route must start with "/"');
  }
  return route ? { workload, route } : { workload };
}

/**
 * Places an independently deployed component in a named workload namespace.
 * `route` is a public HTTP claim; the platform unions routes into ingress.
 * Omit `route` for components that are only reached by binding, not by URL.
 */
export function WorkloadComponent(options: WorkloadComponentOptions) {
  const metadata = componentMetadata(options);
  return <T extends object>(target: T): T => {
    defineMetadata(WORKLOAD_COMPONENT_KEY, metadata, target);
    return target;
  };
}

/**
 * Places a long-running service in a named workload. Not coupled to components.
 */
export function WorkloadService(options: WorkloadServiceOptions) {
  const workload = requireName('WorkloadService', options.workload);
  return <T extends object>(target: T): T => {
    defineMetadata(WORKLOAD_SERVICE_KEY, { workload }, target);
    return target;
  };
}

export function getWorkload(target: object): WorkloadMetadata | undefined {
  return getOwnMetadata(WORKLOAD_KEY, target) as WorkloadMetadata | undefined;
}

export function getWorkloadComponent(target: object): WorkloadComponentOptions | undefined {
  return getOwnMetadata(WORKLOAD_COMPONENT_KEY, target) as WorkloadComponentOptions | undefined;
}

export function getWorkloadService(target: object): WorkloadServiceOptions | undefined {
  return getOwnMetadata(WORKLOAD_SERVICE_KEY, target) as WorkloadServiceOptions | undefined;
}
