import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveExamplesDir(rootDir = process.cwd()): string {
  if (process.env.EXAMPLES_DIR) {
    const custom = resolve(rootDir, process.env.EXAMPLES_DIR);
    if (existsSync(custom)) return custom;
    throw new Error(
      `EXAMPLES_DIR specified (${process.env.EXAMPLES_DIR}) but does not exist at ${custom}`,
    );
  }
  const nested = resolve(rootDir, 'examples');
  if (existsSync(nested) && existsSync(resolve(nested, 'package.json'))) {
    return nested;
  }
  const sibling = resolve(rootDir, '../examples');
  if (existsSync(sibling) && existsSync(resolve(sibling, 'package.json'))) {
    return sibling;
  }
  throw new Error(
    `Could not locate examples workspace. Checked ${nested} and ${sibling}. Set EXAMPLES_DIR to specify location.`,
  );
}

export async function linkFrameworkToExamples(
  frameworkDir = process.cwd(),
  examplesDir = resolveExamplesDir(frameworkDir),
): Promise<string[]> {
  const linkProducersScript = resolve(examplesDir, 'scripts/link-producers.ts');
  if (existsSync(linkProducersScript)) {
    console.log(`Delegating to examples helper: ${linkProducersScript} ${frameworkDir}`);
    const child = Bun.spawn(['bun', linkProducersScript, frameworkDir], {
      cwd: examplesDir,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`examples/scripts/link-producers.ts exited with status ${exitCode}`);
    }
    return [];
  }

  console.log(`Linking framework packages from ${frameworkDir} into examples at ${examplesDir}`);
  const packagesDir = resolve(frameworkDir, 'packages');
  if (!existsSync(packagesDir)) {
    throw new Error(`Framework packages directory not found at ${packagesDir}`);
  }

  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const linkedPackages: Array<{ name: string; directory: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = resolve(packagesDir, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = await Bun.file(pkgJsonPath).json();
    if (pkg.name?.startsWith('@di-framework/')) {
      linkedPackages.push({ name: pkg.name, directory: resolve(packagesDir, entry.name) });
    }
  }

  if (linkedPackages.length === 0) {
    throw new Error(`No @di-framework/* packages found in ${packagesDir}`);
  }

  // Register each package in Bun link store
  for (const { name, directory } of linkedPackages) {
    const linkChild = Bun.spawn(['bun', 'link'], {
      cwd: directory,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await linkChild.exited;
    if (exitCode !== 0) {
      throw new Error(`Could not link package ${name} from ${directory}`);
    }
  }

  // Update overrides in examples/package.json
  const examplesManifestPath = resolve(examplesDir, 'package.json');
  const manifest = await Bun.file(examplesManifestPath).json();
  manifest.overrides = manifest.overrides ?? {};

  for (const { name } of linkedPackages) {
    manifest.overrides[name] = `link:${name}`;
  }

  await Bun.write(examplesManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Run bun install in examples workspace
  console.log(`Installing linked dependencies in ${examplesDir}...`);
  const installChild = Bun.spawn(['bun', 'install'], {
    cwd: examplesDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const installExit = await installChild.exited;
  if (installExit !== 0) {
    throw new Error(`Failed to install dependencies in ${examplesDir}`);
  }

  // Verify symlinks
  for (const { name, directory } of linkedPackages) {
    const nodeModulesPath = resolve(examplesDir, 'node_modules', name);
    if (existsSync(nodeModulesPath)) {
      const actual = realpathSync(nodeModulesPath);
      const expected = realpathSync(directory);
      if (actual !== expected) {
        throw new Error(`Link mismatch for ${name}: expected ${expected}, got ${actual}`);
      }
      console.log(`Verified link: ${name} → ${actual}`);
    }
  }

  // Record framework revision
  const revision = Bun.spawnSync(['git', '-C', frameworkDir, 'rev-parse', 'HEAD']);
  if (revision.exitCode === 0) {
    const localDir = resolve(examplesDir, '.local');
    mkdirSync(localDir, { recursive: true });
    await Bun.write(
      resolve(localDir, 'framework.json'),
      `${JSON.stringify({ directory: frameworkDir, revision: revision.stdout.toString().trim() }, null, 2)}\n`,
    );
  }

  return linkedPackages.map((p) => p.name);
}

if (import.meta.main) {
  try {
    await linkFrameworkToExamples();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
