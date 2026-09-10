import type { CommandNode } from './types.js';

/** Manifest format understood by the di-framework CLI extension loader. */
export const EXTENSION_SCHEMA_VERSION = 1;

/** Command tokens an extension (and each of its subcommands) may claim. */
export const EXTENSION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ExtensionManifest = {
  readonly schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  /** Top-level command token; must match the name derived from the package name. */
  readonly name: string;
  readonly description: string;
  /** Command tree mounted at `di-framework <name>`. */
  readonly command: CommandNode;
};

export type ManifestIssue = { path: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCommandNode(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  if (typeof value.description !== 'string' || value.description.length === 0) {
    issues.push({ path: `${path}.description`, message: 'must be a non-empty string' });
  }
  if (value.usage !== undefined && typeof value.usage !== 'string') {
    issues.push({ path: `${path}.usage`, message: 'must be a string when present' });
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) || value.options.some((option) => typeof option !== 'string'))
  ) {
    issues.push({ path: `${path}.options`, message: 'must be an array of strings when present' });
  }
  const hasChildren = value.children !== undefined;
  const hasRun = value.run !== undefined;
  if (hasChildren === hasRun) {
    issues.push({ path, message: 'must define exactly one of children or run' });
    return;
  }
  if (hasRun && typeof value.run !== 'function') {
    issues.push({ path: `${path}.run`, message: 'must be a function' });
  }
  if (hasChildren) {
    if (!isRecord(value.children)) {
      issues.push({ path: `${path}.children`, message: 'must be an object' });
      return;
    }
    const entries = Object.entries(value.children);
    if (entries.length === 0) {
      issues.push({ path: `${path}.children`, message: 'must contain at least one command' });
    }
    for (const [name, child] of entries) {
      if (!EXTENSION_NAME_PATTERN.test(name)) {
        issues.push({
          path: `${path}.children.${name}`,
          message: `name must match ${EXTENSION_NAME_PATTERN}`,
        });
      }
      validateCommandNode(child, `${path}.children.${name}`, issues);
    }
  }
}

/** Structural validation the CLI runs before mounting an extension command tree. */
export function validateExtensionManifest(value: unknown): ManifestIssue[] {
  if (!isRecord(value)) return [{ path: 'manifest', message: 'must be an object' }];
  const issues: ManifestIssue[] = [];
  if (value.schemaVersion !== EXTENSION_SCHEMA_VERSION) {
    issues.push({ path: 'manifest.schemaVersion', message: `must be ${EXTENSION_SCHEMA_VERSION}` });
  }
  if (typeof value.name !== 'string' || !EXTENSION_NAME_PATTERN.test(value.name)) {
    issues.push({ path: 'manifest.name', message: `must match ${EXTENSION_NAME_PATTERN}` });
  }
  if (typeof value.description !== 'string' || value.description.length === 0) {
    issues.push({ path: 'manifest.description', message: 'must be a non-empty string' });
  }
  validateCommandNode(value.command, 'manifest.command', issues);
  return issues;
}

/** Validates and freezes an extension manifest; export the result as the package default. */
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest {
  const issues = validateExtensionManifest(manifest);
  if (issues.length > 0) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new TypeError(`Invalid extension manifest: ${summary}`);
  }
  return Object.freeze(manifest);
}
