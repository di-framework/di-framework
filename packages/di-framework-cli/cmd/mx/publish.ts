import { join } from 'node:path';
import { $ as defaultShell } from 'bun';

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-config',
  'packages/di-framework-auth',
  'packages/di-framework-authz',
  'packages/di-framework-socket',
  'packages/di-framework-rpc',
  'packages/di-framework-ai',
  'packages/di-framework-ai-utils',
  'packages/di-framework-codegen',
  'packages/di-framework-cli',
  // plugin.cjs + Go sidecar; package.json "build" is a no-op (not tsc/bun compile)
  'packages/di-framework-tsc',
];

/** Bun `$` tagged-template runner; injectable for in-process coverage tests. */
export type PublishShell = typeof defaultShell;

export async function publish(shell: PublishShell = defaultShell) {
  // 1. Run tests
  console.log('🧪 Running tests...');
  for (const pkgDir of PACKAGES) {
    await shell`bun test ${pkgDir}`;
  }

  // 2. Build
  console.log('🏗️  Building packages...');
  await shell`bun run packages/di-framework-cli/cmd/mx/build.ts`;

  // 3. Publish
  for (const pkgDir of PACKAGES) {
    const fullPath = join(process.cwd(), pkgDir);
    const pkgJsonPath = join(fullPath, 'package.json');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const rawPkgJson = readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(rawPkgJson);

    console.log(`\n🚢 Publishing ${pkgJson.name}@${pkgJson.version}...`);

    // Prepare package.json for npm publish: replace workspace:* with ^version
    const publishPkgJson = JSON.parse(rawPkgJson);
    const replaceWorkspaceSpecs = (deps?: Record<string, string>) => {
      if (!deps) return;
      for (const depKey of Object.keys(deps)) {
        if (
          depKey.startsWith('@di-framework/') &&
          (deps[depKey] === 'workspace:*' || deps[depKey] === 'workspace:^')
        ) {
          deps[depKey] = `^${pkgJson.version}`;
        }
      }
    };
    replaceWorkspaceSpecs(publishPkgJson.peerDependencies);
    replaceWorkspaceSpecs(publishPkgJson.dependencies);

    try {
      writeFileSync(pkgJsonPath, `${JSON.stringify(publishPkgJson, null, 2)}\n`);
      await shell`cd ${fullPath} && bun publish --access public`;
      console.log(`  ✅ Published ${pkgJson.name}`);
    } catch (err) {
      console.error(`  ❌ Failed to publish ${pkgJson.name}:`, err);
    } finally {
      writeFileSync(pkgJsonPath, rawPkgJson);
    }
  }

  console.log('\n🏁 Publish process finished!');
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handlePublishFailure(err: unknown): never {
  console.error('❌ Publish script failed:', err);
  process.exit(1);
}

/** CLI main gate — `isMain` is injectable so tests can cover the entry path. */
export function runPublishMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => publish().catch(handlePublishFailure),
): void {
  if (isMain) {
    void start();
  }
}

runPublishMain();
