/**
 * Rewrite published internal `@di-framework/*` dependency ranges in every
 * release package so they accept the workspace root version (typically `^<major>`).
 *
 * Used by the Release workflow before `check-packaging` and publish so packed
 * manifests are what npm will ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGES } from '../packages/di-framework-cli/cmd/mx/build';
import { preparePublishManifest, validateInternalFrameworkDeps } from './internal-framework-deps';

export function prepareAllPublishManifests(workspaceRoot = process.cwd()): {
  releaseVersion: string;
  updated: string[];
} {
  const rootPkg = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const releaseVersion = rootPkg.version;
  const updated: string[] = [];

  for (const pkgDir of PACKAGES) {
    const pkgJsonPath = join(workspaceRoot, pkgDir, 'package.json');
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(raw) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    // Prefer the package version after `mx build --sync-versions`; fall back to root.
    const version = pkgJson.version || releaseVersion;
    const prepared = preparePublishManifest(pkgJson, version);
    const issues = validateInternalFrameworkDeps(prepared, version);
    if (issues.length > 0) {
      const detail = issues.map((i) => i.message).join('; ');
      throw new Error(`Refusing to prepare ${pkgJson.name}@${version}: ${detail}`);
    }

    writeFileSync(pkgJsonPath, `${JSON.stringify(prepared, null, 2)}\n`);
    updated.push(pkgJson.name);
  }

  return { releaseVersion, updated };
}

if (import.meta.main) {
  try {
    const { releaseVersion, updated } = prepareAllPublishManifests();
    console.log(
      `Prepared ${updated.length} package manifests for release ${releaseVersion} (${updated.join(', ')})`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
