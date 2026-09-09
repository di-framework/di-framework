import { CommandFailure, EXTENSION_NAME_PATTERN } from '../command';

/**
 * Top-level tokens extensions may never claim. Mirrors the built-in command tree;
 * tests assert this list matches `COMMAND_TREE` exactly.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = [
  'help',
  'init',
  'generate',
  'build',
  'check',
  'agent',
  'http',
  'skills',
  'mx',
  'queue',
  'extensions',
];

const PACKAGE_NAME_FORMS = [
  /^@di-framework\/cli-plugin-(?<name>.+)$/,
  /^di-framework-cli-plugin-(?<name>.+)$/,
  /^@[a-z0-9-~][a-z0-9-._~]*\/di-framework-cli-plugin-(?<name>.+)$/,
];

/** Command token for an extension package name, or undefined for non-extension packages. */
export function deriveCommandName(packageName: string): string | undefined {
  for (const form of PACKAGE_NAME_FORMS) {
    const name = form.exec(packageName)?.groups?.name;
    if (name !== undefined) {
      return EXTENSION_NAME_PATTERN.test(name) ? name : undefined;
    }
  }
  return undefined;
}

/**
 * Package names that may provide `di-framework <token>`, most-canonical first.
 * Arbitrary-scope packages are only considered when already installed, so they
 * must be listed in `installed`.
 */
export function candidatePackageNames(token: string, installed: readonly string[]): string[] {
  const canonical = [`@di-framework/cli-plugin-${token}`, `di-framework-cli-plugin-${token}`];
  const scoped = installed.filter(
    (name) => !canonical.includes(name) && deriveCommandName(name) === token,
  );
  return [...canonical, ...scoped];
}

export type InstallSpec = {
  packageName: string;
  commandName: string;
  range?: string;
};

/**
 * Parse an `extensions install` argument: a bare extension name (canonicalized to
 * `@di-framework/cli-plugin-<name>`) or one of the accepted package-name forms,
 * optionally suffixed with `@<range>`.
 */
export function normalizeInstallSpec(spec: string): InstallSpec {
  const separator = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const rawName = separator === -1 ? spec : spec.slice(0, separator);
  const range = separator === -1 ? undefined : spec.slice(separator + 1);
  if (rawName === '' || range === '') {
    throw new CommandFailure('INVALID_USAGE', `Invalid extension spec: ${spec}`, 2, { spec });
  }
  if (EXTENSION_NAME_PATTERN.test(rawName)) {
    return { packageName: `@di-framework/cli-plugin-${rawName}`, commandName: rawName, range };
  }
  const commandName = deriveCommandName(rawName);
  if (commandName === undefined) {
    throw new CommandFailure(
      'INVALID_USAGE',
      `Not a CLI extension package: ${rawName} (expected @di-framework/cli-plugin-<name>, di-framework-cli-plugin-<name>, or @<scope>/di-framework-cli-plugin-<name>)`,
      2,
      { spec },
    );
  }
  return { packageName: rawName, commandName, range };
}
