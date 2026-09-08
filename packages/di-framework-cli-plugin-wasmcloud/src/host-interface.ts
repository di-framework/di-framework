import {
  type AggregatedRequirement,
  aggregateRequirements,
  parsePackageId,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_PACKAGE,
  type WitRequirement,
} from './wit.js';

export type HostInterface = {
  name?: string;
  namespace: string;
  package: string;
  version: string;
  interfaces: string[];
  config?: Record<string, string>;
  configFrom?: Array<{ name: string }>;
  secretFrom?: Array<{ name: string }>;
};

export type HostInterfaceOptions = {
  httpHost?: string;
};

export type BindingHostOverlay = {
  name: string;
  className: string;
  config?: Record<string, string>;
  configFrom?: string;
  secretFrom?: string;
};

function hostInterfaceFromRequirement(
  requirement: AggregatedRequirement,
  options: HostInterfaceOptions,
): HostInterface {
  const { namespace, name } = parsePackageId(requirement.package);
  const entry: HostInterface = {
    namespace,
    package: name,
    version: requirement.version,
    interfaces: [...requirement.interfaces],
  };
  if (requirement.instanceName !== undefined) entry.name = requirement.instanceName;
  if (
    requirement.package === WASI_HTTP_PACKAGE &&
    requirement.interfaces.includes(WASI_HTTP_INTERFACE) &&
    options.httpHost !== undefined
  ) {
    entry.config = { host: options.httpHost };
  }
  return entry;
}

export function hostInterfacesFromRequirements(
  requirements: readonly WitRequirement[],
  options: HostInterfaceOptions = {},
  overlays: readonly BindingHostOverlay[] = [],
): HostInterface[] {
  const byName = new Map(overlays.map((overlay) => [overlay.name, overlay]));
  return aggregateRequirements(requirements).map((requirement) => {
    const entry = hostInterfaceFromRequirement(requirement, options);
    const overlay =
      requirement.instanceName !== undefined ? byName.get(requirement.instanceName) : undefined;
    if (overlay === undefined) return entry;
    if (overlay.config !== undefined) {
      entry.config = { ...entry.config, ...overlay.config };
    }
    if (overlay.configFrom !== undefined) entry.configFrom = [{ name: overlay.configFrom }];
    if (overlay.secretFrom !== undefined) entry.secretFrom = [{ name: overlay.secretFrom }];
    return entry;
  });
}

export function renderHostInterfacesYaml(interfaces: readonly HostInterface[]): string {
  if (interfaces.length === 0) return '';
  const lines = ['      hostInterfaces:'];
  for (const entry of interfaces) {
    if (entry.name !== undefined) {
      lines.push(`        - name: ${yamlQuote(entry.name)}`);
      lines.push(`          namespace: ${entry.namespace}`);
    } else {
      lines.push(`        - namespace: ${entry.namespace}`);
    }
    lines.push(`          package: ${entry.package}`);
    lines.push(`          version: ${yamlQuote(entry.version)}`);
    lines.push('          interfaces:');
    for (const iface of entry.interfaces) lines.push(`            - ${iface}`);
    if (entry.config !== undefined) {
      lines.push('          config:');
      for (const [key, value] of Object.entries(entry.config)) {
        lines.push(`            ${yamlQuote(key)}: ${yamlQuote(value)}`);
      }
    }
    if (entry.configFrom !== undefined) {
      lines.push('          configFrom:');
      for (const ref of entry.configFrom) lines.push(`            - name: ${yamlQuote(ref.name)}`);
    }
    if (entry.secretFrom !== undefined) {
      lines.push('          secretFrom:');
      for (const ref of entry.secretFrom) lines.push(`            - name: ${yamlQuote(ref.name)}`);
    }
  }
  return lines.join('\n');
}

export function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
