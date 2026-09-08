/**
 * Release-time alignment and validation for internal `@di-framework/*` dependency ranges.
 *
 * Published packages must declare ranges that accept the version being released
 * (e.g. a 5.2.0 release uses `^5`). Ranges are derived from the release version's
 * major — never hard-coded.
 *
 * Intentional cross-major relationships must be listed in
 * {@link INTERNAL_CROSS_MAJOR_ALLOWLIST} as `consumingPackage>dependencyPackage`.
 */

export const PUBLISHED_DEP_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type PublishedDepField = (typeof PUBLISHED_DEP_FIELDS)[number];

export type ManifestDeps = Partial<Record<PublishedDepField, Record<string, string> | undefined>>;

/**
 * Allowlist of intentional cross-major `@di-framework/*` relationships.
 * Format: `"@di-framework/consuming>@di-framework/dependency"`.
 *
 * Entries skip both prepare rewrite and release validation. Keep empty unless a
 * cross-major peer or dependency is genuinely required; document each addition
 * in PACKAGING.md.
 */
export const INTERNAL_CROSS_MAJOR_ALLOWLIST = new Set<string>([
  '@di-framework/cli-plugin-wasmcloud>@di-framework/componentize-qjs',
]);

export function isInternalFrameworkPackage(name: string): boolean {
  return name.startsWith('@di-framework/');
}

export function allowlistKey(consumer: string, dependency: string): string {
  return `${consumer}>${dependency}`;
}

export function isAllowlistedInternalDep(consumer: string, dependency: string): boolean {
  return INTERNAL_CROSS_MAJOR_ALLOWLIST.has(allowlistKey(consumer, dependency));
}

/** Major version integer from a semver string (ignores leading `v`). */
export function frameworkMajor(version: string): number {
  const normalized = version.trim().replace(/^v/i, '');
  const majorPart = normalized.split('.')[0];
  const major = Number.parseInt(majorPart ?? '', 10);
  if (!Number.isFinite(major) || major < 0 || majorPart === undefined || majorPart === '') {
    throw new Error(`Cannot derive framework major from version "${version}"`);
  }
  return major;
}

/** Canonical published range for internal framework deps at a given release. */
export function frameworkInternalRange(releaseVersion: string): string {
  return `^${frameworkMajor(releaseVersion)}`;
}

export function rangeAcceptsRelease(range: string, releaseVersion: string): boolean {
  if (range.startsWith('workspace:')) return false;
  try {
    return Bun.semver.satisfies(releaseVersion.replace(/^v/i, ''), range);
  } catch {
    return false;
  }
}

export interface InternalDepIssue {
  field: PublishedDepField;
  dependency: string;
  range: string;
  message: string;
}

/** Validate that every published internal `@di-framework/*` range accepts the release version. */
export function validateInternalFrameworkDeps(
  pkg: ManifestDeps & { name?: string },
  releaseVersion: string,
): InternalDepIssue[] {
  const consumer = pkg.name ?? '<unknown>';
  const issues: InternalDepIssue[] = [];

  for (const field of PUBLISHED_DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [dependency, range] of Object.entries(deps)) {
      if (!isInternalFrameworkPackage(dependency)) continue;
      if (isAllowlistedInternalDep(consumer, dependency)) continue;
      if (typeof range !== 'string') {
        issues.push({
          field,
          dependency,
          range: String(range),
          message: `${field}.${dependency} must be a string semver range`,
        });
        continue;
      }
      if (!rangeAcceptsRelease(range, releaseVersion)) {
        const expected = frameworkInternalRange(releaseVersion);
        issues.push({
          field,
          dependency,
          range,
          message: `${field}.${dependency} range "${range}" does not accept release ${releaseVersion} (expected ${expected} or another compatible range)`,
        });
      }
    }
  }

  return issues;
}

/**
 * Rewrite published internal `@di-framework/*` specs for publish:
 * - `workspace:*` / `workspace:^` → `^<major>`
 * - any range that does not accept the release version → `^<major>`
 * Allowlisted cross-major entries are left unchanged.
 */
export function preparePublishManifest<
  T extends ManifestDeps & { name?: string; version?: string },
>(pkg: T, releaseVersion: string): T {
  const range = frameworkInternalRange(releaseVersion);
  const consumer = pkg.name ?? '<unknown>';
  const prepared = structuredClone(pkg);

  for (const field of PUBLISHED_DEP_FIELDS) {
    const deps = prepared[field];
    if (!deps) continue;
    for (const dependency of Object.keys(deps)) {
      if (!isInternalFrameworkPackage(dependency)) continue;
      if (isAllowlistedInternalDep(consumer, dependency)) continue;
      const current = deps[dependency];
      if (
        current === 'workspace:*' ||
        current === 'workspace:^' ||
        typeof current !== 'string' ||
        !rangeAcceptsRelease(current, releaseVersion)
      ) {
        deps[dependency] = range;
      }
    }
  }

  return prepared;
}
