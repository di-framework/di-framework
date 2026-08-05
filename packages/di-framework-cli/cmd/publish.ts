import { $ as defaultShell } from 'bun';
import { join } from 'path';

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-config',
  'packages/di-framework-auth',
  'packages/di-framework-socket',
  'packages/di-framework-rpc',
  'packages/di-framework-ai',
  'packages/di-framework-cli',
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
  await shell`bun run packages/di-framework-cli/cmd/build.ts`;

  // 3. Publish
  for (const pkgDir of PACKAGES) {
    const fullPath = join(process.cwd(), pkgDir);
    const pkgJson = await import(join(fullPath, 'package.json'));

    console.log(`\n🚢 Publishing ${pkgJson.name}@${pkgJson.version}...`);

    // Using --access public for scoped packages
    // We use npm publish or bun publish. Bun publish is fine.
    try {
      await shell`cd ${fullPath} && bun publish --access public`;
      console.log(`  ✅ Published ${pkgJson.name}`);
    } catch (err) {
      console.error(`  ❌ Failed to publish ${pkgJson.name}:`, err);
      // Depending on needs, we might want to continue or stop
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
