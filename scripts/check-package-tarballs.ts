import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkspacePackages } from './coverage-mapping';
import { frameworkInternalRange, validateInternalFrameworkDeps } from './internal-framework-deps';

interface PackedFile {
  path: string;
  size: number;
  mode?: number;
}

interface PackJsonResult {
  id: string;
  name: string;
  version: string;
  filename: string;
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

function readReleaseVersion(cwd: string): string {
  const fromEnv = process.env.DI_RELEASE_VERSION?.trim();
  if (fromEnv) return fromEnv.replace(/^v/i, '');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (!rootPkg.version) {
    throw new Error('Workspace root package.json is missing version');
  }
  return rootPkg.version;
}

function readPackedPackageJson(tarballPath: string): Record<string, unknown> {
  const raw = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

export function checkPackageTarballs(): boolean {
  const workspacePackages = getWorkspacePackages();
  const cwd = process.cwd();
  const releaseVersion = readReleaseVersion(cwd);
  const expectedInternalRange = frameworkInternalRange(releaseVersion);
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-pack-audit-'));

  console.log(
    `📦 Auditing packaging tarballs for all ${workspacePackages.length} published packages...\n`,
  );
  console.log(
    `📌 Release version ${releaseVersion} (internal @di-framework/* ranges must accept it, typically ${expectedInternalRange})\n`,
  );

  let totalErrors = 0;

  try {
    for (const pkg of workspacePackages) {
      const pkgDirPath = path.join(cwd, pkg.relPath);
      const pkgJsonPath = path.join(pkgDirPath, 'package.json');

      if (!fs.existsSync(pkgJsonPath)) {
        console.error(`❌ Missing package.json in ${pkgDirPath}`);
        totalErrors++;
        continue;
      }

      const sourcePkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<
        string,
        unknown
      >;
      const pkgName: string = (sourcePkgJson.name as string) || pkg.name;

      console.log(`Checking ${pkgName} (${pkg.dirName})...`);

      let packData: PackJsonResult;
      let packedManifest: Record<string, unknown>;
      try {
        const out = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
          cwd: pkgDirPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        packData = JSON.parse(out)[0] as PackJsonResult;
        const tarballPath = path.join(packDir, packData.filename);
        packedManifest = readPackedPackageJson(tarballPath);
      } catch (err) {
        console.error(`❌ Failed to pack ${pkgName}:`, err);
        totalErrors++;
        continue;
      }

      const packedFiles = packData.files.map((f) => f.path);
      const packedFileSet = new Set(packedFiles);
      console.log(
        `  ${packData.size} bytes packed, ${packData.unpackedSize} bytes unpacked, ${packData.entryCount} files`,
      );

      // Validate dependency fields from the packed package.json, not only the source tree.
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        for (const [dependency, version] of Object.entries(
          (packedManifest[field] as Record<string, string> | undefined) ?? {},
        )) {
          if (typeof version === 'string' && version.startsWith('workspace:')) {
            console.error(
              `  ❌ [${pkgName}] Packed ${field}.${dependency} uses unresolved protocol "${version}"`,
            );
            totalErrors++;
          }
        }
      }

      const internalIssues = validateInternalFrameworkDeps(
        {
          name: pkgName,
          dependencies: packedManifest.dependencies as Record<string, string> | undefined,
          optionalDependencies: packedManifest.optionalDependencies as
            | Record<string, string>
            | undefined,
          peerDependencies: packedManifest.peerDependencies as Record<string, string> | undefined,
        },
        releaseVersion,
      );
      for (const issue of internalIssues) {
        console.error(`  ❌ [${pkgName}] ${issue.message}`);
        totalErrors++;
      }

      // a) Verify main, module, types, and exports exist inside packed files
      const pathsToCheck: Array<{ field: string; path: string }> = [];

      if (typeof packedManifest.main === 'string') {
        pathsToCheck.push({ field: 'main', path: packedManifest.main });
      }
      if (typeof packedManifest.module === 'string') {
        pathsToCheck.push({ field: 'module', path: packedManifest.module });
      }
      if (typeof packedManifest.types === 'string') {
        pathsToCheck.push({ field: 'types', path: packedManifest.types });
      }
      for (const binPath of Object.values(
        (packedManifest.bin as Record<string, string> | undefined) ?? {},
      )) {
        if (typeof binPath === 'string') pathsToCheck.push({ field: 'bin', path: binPath });
      }

      if (packedManifest.exports) {
        const exportPaths = extractPathsFromExports(packedManifest.exports);
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

        if (!isRawTsAllowed && file.endsWith('.ts') && !file.endsWith('.d.ts')) {
          console.error(
            `  ❌ [${pkgName}] Packed file contains forbidden raw TypeScript source file: "${file}"`,
          );
          totalErrors++;
        }
      }
    }
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
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
