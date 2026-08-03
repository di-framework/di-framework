import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const PACKAGES = [
  'packages/di-framework-core',
  'packages/di-framework-repo',
  'packages/di-framework-http',
  'packages/di-framework-graphql',
  'packages/di-framework-events',
  'packages/di-framework-config',
  'packages/di-framework-auth',
  'packages/di-framework-cli',
];

export async function build() {
  console.log('🚀 Starting build process...');

  const rootPkgPath = join(process.cwd(), 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  const version = rootPkg.version;
  console.log(`📌 Using version ${version} from workspace root`);

  for (const pkgDir of PACKAGES) {
    console.log(`\n📦 Building ${pkgDir}...`);
    const fullPath = join(process.cwd(), pkgDir);

    // Sync version
    const pkgJsonPath = join(fullPath, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      writeFileSync(pkgJsonPath, JSON.stringify({ ...pkgJson, version }, null, 2) + '\n');
    }

    // 1. Clean dist
    await $`rm -rf ${join(fullPath, 'dist')}`;

    // 2. Run build
    console.log('  Running build...');
    if (existsSync(join(fullPath, 'tsconfig.build.json'))) {
      await $`cd ${fullPath} && bun x tsc -p tsconfig.build.json`;
    } else {
      await $`cd ${fullPath} && bun run build`;
    }

    console.log(`  ✅ Finished building ${pkgDir}`);
  }

  console.log('\n✨ All builds completed successfully!');
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handleBuildFailure(err: unknown): never {
  console.error('❌ Build failed:', err);
  process.exit(1);
}

if (import.meta.main) {
  build().catch(handleBuildFailure);
}
