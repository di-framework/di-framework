import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Component-model / WASI preview the guest targets. Independent of any package version. */
export const COMPONENT_MODEL = '0.3';

export const HTTP_ADAPTER_SOURCE = 'http-adapter';
export const WASI_HTTP_PACKAGE = 'wasi:http';
export const WASI_HTTP_VERSION = '0.3.0';
export const WASI_HTTP_INTERFACE = 'handler';

export type WitDirection = 'import' | 'export';

/**
 * One adapter or binding's WIT needs. A requirement is an interface group:
 * `interfaces` share resource identity and become one hostInterfaces entry.
 */
export type WitRequirement = {
  package: string;
  version: string;
  interfaces: string[];
  direction: WitDirection;
  instanceName?: string;
  source: string;
};

export type AggregatedRequirement = WitRequirement & { sources: string[] };

export type WitPackageLock = {
  id: string;
  version: string;
  source: 'bundled';
  path: string;
  digest: string;
};

export type WitLock = {
  schemaVersion: 1;
  componentModel: string;
  world: string;
  requirements: AggregatedRequirement[];
  packages: WitPackageLock[];
};

export const HTTP_ADAPTER_REQUIREMENTS: WitRequirement[] = [
  {
    package: WASI_HTTP_PACKAGE,
    version: WASI_HTTP_VERSION,
    interfaces: [WASI_HTTP_INTERFACE],
    direction: 'export',
    source: HTTP_ADAPTER_SOURCE,
  },
];

/** Default guest world: the HTTP adapter only. Bindings later concat onto this list. */
export function defaultProjectRequirements(): WitRequirement[] {
  return HTTP_ADAPTER_REQUIREMENTS.map((requirement) => ({ ...requirement }));
}

export function parsePackageId(id: string): { namespace: string; name: string } {
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`Invalid WIT package id "${id}"`);
  }
  return { namespace: id.slice(0, separator), name: id.slice(separator + 1) };
}

function requirementKey(requirement: WitRequirement): string {
  return [
    requirement.direction,
    requirement.package,
    requirement.version,
    requirement.instanceName ?? '',
  ].join('\0');
}

/** Merge interface groups that share package, version, direction, and instance name. */
export function aggregateRequirements(
  requirements: readonly WitRequirement[],
): AggregatedRequirement[] {
  const groups = new Map<string, AggregatedRequirement>();
  for (const requirement of requirements) {
    if (requirement.interfaces.length === 0) continue;
    const key = requirementKey(requirement);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        ...requirement,
        interfaces: [...requirement.interfaces],
        sources: [requirement.source],
      });
      continue;
    }
    for (const iface of requirement.interfaces) {
      if (!existing.interfaces.includes(iface)) existing.interfaces.push(iface);
    }
    if (!existing.sources.includes(requirement.source)) existing.sources.push(requirement.source);
  }
  return [...groups.values()];
}

function importClause(requirement: AggregatedRequirement, iface: string): string {
  const { namespace, name } = parsePackageId(requirement.package);
  const target = `${namespace}:${name}/${iface}@${requirement.version}`;
  if (requirement.direction === 'export') return `export ${target};`;
  // qjs cannot encode `import name: pkg/iface` (cm-implements). Named instances
  // still appear on hostInterfaces; the guest world is unlabeled.
  return `import ${target};`;
}

export function renderWorldWit(
  packageName: string,
  version: string,
  requirements: readonly WitRequirement[],
): string {
  const lines = [`package local:${packageName}@${version};`, '', 'world application {'];
  const seen = new Set<string>();
  for (const requirement of aggregateRequirements(requirements)) {
    for (const iface of requirement.interfaces) {
      const clause = importClause(requirement, iface);
      if (seen.has(clause)) continue;
      seen.add(clause);
      lines.push(`  ${clause}`);
    }
  }
  lines.push('}', '');
  return lines.join('\n');
}

function packageIdFromWit(contents: string): { id: string; version: string } | undefined {
  const match = contents.match(/^package\s+([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)@([0-9][^;\s]*)/m);
  if (match == null) return undefined;
  return { id: match[1] ?? '', version: match[2] ?? '' };
}

export function digestBytes(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildWitLock(
  requirements: readonly WitRequirement[],
  witDepsDirectory: string,
): WitLock {
  const packages: WitPackageLock[] = [];
  for (const entry of readdirSync(witDepsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(entry.name, 'package.wit');
    const absolute = join(witDepsDirectory, path);
    let contents: string;
    try {
      contents = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const parsed = packageIdFromWit(contents);
    if (parsed === undefined) continue;
    packages.push({
      id: parsed.id,
      version: parsed.version,
      source: 'bundled',
      path: `wit/deps/${path.replaceAll('\\', '/')}`,
      digest: digestBytes(contents),
    });
  }
  packages.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    componentModel: COMPONENT_MODEL,
    world: 'application',
    requirements: aggregateRequirements(requirements),
    packages,
  };
}
