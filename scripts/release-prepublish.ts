/**
 * Shared pre-publish gate used by Release and by PR dry-runs.
 *
 * Assumes packages were built with `mx build --sync-versions`. Rewrites
 * internal `@di-framework/*` ranges, audits packed manifests, and optionally
 * runs `npm publish --dry-run` without uploading.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PACKAGES } from '../packages/di-framework-cli/cmd/mx/build';
import { checkPackageTarballs } from './check-package-tarballs';
import { prepareAllPublishManifests } from './prepare-publish-manifests';

export function parseReleasePrepublishArgs(args: readonly string[] = process.argv.slice(2)): {
  publishDryRun: boolean;
} {
  for (const arg of args) {
    if (arg !== '--publish-dry-run') {
      throw new Error(`Unknown release-prepublish argument: ${arg}`);
    }
  }
  return { publishDryRun: args.includes('--publish-dry-run') };
}

export function runReleasePrepublish(
  options: { publishDryRun: boolean; workspaceRoot?: string } = { publishDryRun: false },
): void {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const { releaseVersion, updated } = prepareAllPublishManifests(workspaceRoot);
  console.log(
    `Prepared ${updated.length} package manifests for release ${releaseVersion} (${updated.join(', ')})`,
  );

  if (!checkPackageTarballs()) {
    throw new Error('Packed manifest audit failed; refusing to continue toward publish');
  }

  if (!options.publishDryRun) return;

  for (const pkgDir of PACKAGES) {
    console.log(`\n🧪 npm publish --dry-run ${pkgDir}`);
    execFileSync('npm', ['publish', '--dry-run', '--ignore-scripts'], {
      cwd: join(workspaceRoot, pkgDir),
      stdio: 'inherit',
    });
  }
}

if (import.meta.main) {
  try {
    runReleasePrepublish(parseReleasePrepublishArgs());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
