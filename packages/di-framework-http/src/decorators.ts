import { getOwnMetadata, useContainer } from '@di-framework/di-framework/container';
import { Container as ContainerDecorator } from '@di-framework/di-framework/decorators';
import registry from './registry.ts';

const INJECT_METADATA_KEY = 'di:inject';
export const SCHEMAS = Symbol.for('proseva:component-schemas');

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ContainerLike {
  resolve(token: unknown): unknown;
}

export function Controller(options: { singleton?: boolean; container?: any } = {}) {
  // Compose DI registration with OpenAPI registry marking
  const containerDecorator = ContainerDecorator(options);
  return (target: any) => {
    // Mark for HTTP/OpenAPI purposes
    target.isController = true;
    registry.addTarget(target);

    // Also register with the DI container (same instance as core framework)
    containerDecorator(target);

    const container: ContainerLike = (options.container ?? useContainer()) as ContainerLike;

    const rawMetadata: unknown = getOwnMetadata(INJECT_METADATA_KEY, target) as unknown;
    const injectMetadata: UnknownRecord = isRecord(rawMetadata) ? rawMetadata : {};

    for (const [propName, targetType] of Object.entries(injectMetadata)) {
      if (!propName.startsWith('param_') && targetType) {
        (target as UnknownRecord)[propName] = container.resolve(targetType);
      }
    }
  };
}

/** Extract all `#/components/schemas/<Name>` references from a metadata tree. */
function extractSchemaRefs(obj: unknown, out: Set<string>): void {
  if (typeof obj !== 'object' || obj === null) return;

  if (Array.isArray(obj)) {
    for (const item of obj) extractSchemaRefs(item, out);
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value);
      if (match?.[1]) out.add(match[1]);
    } else {
      extractSchemaRefs(value, out);
    }
  }
}

export function Endpoint(metadata?: {
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: any;
  responses?: Record<string, any>;
}) {
  return (target: any, propertyKey?: string) => {
    if (propertyKey) {
      const property = target[propertyKey];

      // For static methods on a class, target is the constructor.
      // If it's a static method, target itself is the constructor.
      const ctor = typeof target === 'function' ? target : target.constructor;
      registry.addTarget(ctor);

      // We'll let the generator discover the details from the property for now,
      // or we could register it explicitly here if we had path/method info.
      // Since TypedRouter adds path/method to the handler, we keep it as is
      // but we can ensure the metadata is attached.
      if (property) {
        property.isEndpoint = true;
        if (metadata) {
          property.metadata = metadata;
        }
      }

      // Also attach schemas if metadata is provided
      if (metadata) {
        const existing: Set<string> =
          (ctor as Record<symbol, Set<string>>)[SCHEMAS] ?? new Set<string>();
        extractSchemaRefs(metadata, existing);
        (ctor as Record<symbol, Set<string>>)[SCHEMAS] = existing;
      }
    } else {
      target.isEndpoint = true;
      if (metadata) {
        target.metadata = metadata;
        const existing: Set<string> =
          (target as Record<symbol, Set<string>>)[SCHEMAS] ?? new Set<string>();
        extractSchemaRefs(metadata, existing);
        (target as Record<symbol, Set<string>>)[SCHEMAS] = existing;
      }
      registry.addTarget(target);
    }
  };
}
