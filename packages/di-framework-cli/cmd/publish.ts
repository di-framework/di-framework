import { $ } from 'bun';
import { join } from 'path';

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-cli',
];

export async function publish() {
  // 1. Run tests
  console.log('🧪 Running tests...');
  for (const pkgDir of PACKAGES) {
    await $`bun test ${pkgDir}`;
  }

  // 2. Build
  console.log('🏗️  Building packages...');
  await $`bun run packages/di-framework-cli/cmd/build.ts`;

  // 3. Publish
  for (const pkgDir of PACKAGES) {
    const fullPath = join(process.cwd(), pkgDir);
    const pkgJson = await import(join(fullPath, 'package.json'));

    console.log(`\n🚢 Publishing ${pkgJson.name}@${pkgJson.version}...`);

    // Using --access public for scoped packages
    // We use npm publish or bun publish. Bun publish is fine.
    try {
      await $`cd ${fullPath} && bun publish --access public`;
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

if (import.meta.main) {
  publish().catch(handlePublishFailure);
}
