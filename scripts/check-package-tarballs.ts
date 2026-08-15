import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspacePackages } from './coverage-mapping';

interface PackedFile {
  path: string;
  size: number;
  mode?: number;
}

interface PackJsonResult {
  id: string;
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}

// Packages allowed to include raw .ts source implementation files
const RAW_TS_ALLOWED_PACKAGES = new Set([
  '@di-framework/cli',
  '@di-framework/tsc',
  '@di-framework/ai',
]);

function extractPathsFromExports(exportsObj: unknown): string[] {
  const paths: string[] = [];
  if (!exportsObj) return paths;

  if (typeof exportsObj === 'string') {
    paths.push(exportsObj);
    return paths;
  }

  if (typeof exportsObj === 'object' && exportsObj !== null) {
    for (const val of Object.values(exportsObj)) {
      if (typeof val === 'string') {
        paths.push(val);
      } else if (typeof val === 'object' && val !== null) {
        paths.push(...extractPathsFromExports(val));
      }
    }
  }

  return paths;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '');
}

function matchesPath(expectedPath: string, packedFileSet: Set<string>): boolean {
  const norm = normalizePath(expectedPath);
  if (packedFileSet.has(norm)) return true;

  if (norm.includes('*')) {
    const regexPattern = `^${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`;
    const regex = new RegExp(regexPattern);
    for (const file of packedFileSet) {
      if (regex.test(file)) return true;
    }
  }

  return false;
}

export function checkPackageTarballs(): boolean {
  const workspacePackages = getWorkspacePackages();
  console.log(
    `📦 Auditing packaging tarballs for all ${workspacePackages.length} published packages...\n`,
  );

  let totalErrors = 0;
  const cwd = process.cwd();

  for (const pkg of workspacePackages) {
    const pkgDirPath = path.join(cwd, pkg.relPath);
    const pkgJsonPath = path.join(pkgDirPath, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) {
      console.error(`❌ Missing package.json in ${pkgDirPath}`);
      totalErrors++;
      continue;
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const pkgName: string = pkgJson.name || pkg.name;

    console.log(`Checking ${pkgName} (${pkg.dirName})...`);

    let packData: PackJsonResult;
    try {
      const out = execSync('npm pack --dry-run --json', {
        cwd: pkgDirPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      packData = JSON.parse(out)[0] as PackJsonResult;
    } catch (err) {
      console.error(`❌ Failed to run \`npm pack --dry-run --json\` for ${pkgName}:`, err);
      totalErrors++;
      continue;
    }

    const packedFiles = packData.files.map((f) => f.path);
    const packedFileSet = new Set(packedFiles);

    // a) Verify main, module, types, and exports exist inside packed files
    const pathsToCheck: Array<{ field: string; path: string }> = [];

    if (pkgJson.main) pathsToCheck.push({ field: 'main', path: pkgJson.main });
    if (pkgJson.module) pathsToCheck.push({ field: 'module', path: pkgJson.module });
    if (pkgJson.types) pathsToCheck.push({ field: 'types', path: pkgJson.types });

    if (pkgJson.exports) {
      const exportPaths = extractPathsFromExports(pkgJson.exports);
      for (const ep of exportPaths) {
        pathsToCheck.push({ field: 'exports', path: ep });
      }
    }

    for (const { field, path: targetPath } of pathsToCheck) {
      if (!matchesPath(targetPath, packedFileSet)) {
        console.error(
          `  ❌ [${pkgName}] Exported ${field} path "${targetPath}" is missing from packed tarball!`,
        );
        totalErrors++;
      }
    }

    // b) Verify no test files, tests/, examples/, or forbidden raw .ts files
    const isRawTsAllowed = RAW_TS_ALLOWED_PACKAGES.has(pkgName);

    for (const file of packedFiles) {
      // Forbidden in all packages: test files, tests/, examples/
      if (
        file.endsWith('.test.ts') ||
        file.endsWith('.spec.ts') ||
        file.startsWith('tests/') ||
        file.includes('/tests/') ||
        file.startsWith('examples/') ||
        file.includes('/examples/')
      ) {
        console.error(
          `  ❌ [${pkgName}] Packed file contains forbidden test/example file: "${file}"`,
        );
        totalErrors++;
      }

      // Forbidden in runtime packages: raw .ts source files (excluding .d.ts)
      if (!isRawTsAllowed && file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        console.error(
          `  ❌ [${pkgName}] Packed file contains forbidden raw TypeScript source file: "${file}"`,
        );
        totalErrors++;
      }
    }
  }

  if (totalErrors > 0) {
    console.error(`\n❌ Packaging audit failed with ${totalErrors} error(s).`);
    return false;
  }

  console.log(
    `\n✨ Packaging audit completed successfully! All ${workspacePackages.length} packages verified.`,
  );
  return true;
}

if (import.meta.main) {
  const success = checkPackageTarballs();
  if (!success) {
    process.exit(1);
  }
}
