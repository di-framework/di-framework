import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  frameworkInternalRange,
  validateInternalFrameworkDeps,
} from '../packages/di-framework-cli/scripts/internal-framework-deps';
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
  filename: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}

export type { PackedFile, PackJsonResult };

// Packages allowed to include raw .ts source implementation files
const RAW_TS_ALLOWED_PACKAGES = new Set([
  '@di-framework/cli',
  '@di-framework/tsc',
  '@di-framework/ai',
  // Ships src alongside dist so the bun-run @di-framework/cli can resolve its
  // "bun" export condition without a build step.
  '@di-framework/cli-extension',
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

function asPackResult(value: unknown): PackJsonResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const filename = (value as { filename?: unknown }).filename;
  if (typeof filename !== 'string' || filename.length === 0) return undefined;

  const files = Array.isArray((value as { files?: unknown }).files)
    ? (value as PackJsonResult).files
    : [];

  return {
    id: typeof (value as PackJsonResult).id === 'string' ? (value as PackJsonResult).id : '',
    name: typeof (value as PackJsonResult).name === 'string' ? (value as PackJsonResult).name : '',
    version:
      typeof (value as PackJsonResult).version === 'string'
        ? (value as PackJsonResult).version
        : '',
    filename,
    size: typeof (value as PackJsonResult).size === 'number' ? (value as PackJsonResult).size : 0,
    unpackedSize:
      typeof (value as PackJsonResult).unpackedSize === 'number'
        ? (value as PackJsonResult).unpackedSize
        : 0,
    entryCount:
      typeof (value as PackJsonResult).entryCount === 'number'
        ? (value as PackJsonResult).entryCount
        : files.length,
    files,
  };
}

/**
 * npm 10 emits `[{ filename, files, ... }]`. Some npm 11 / Bun shims emit a
 * single pack object. Current npm latest keys that object by package name:
 * `{ "@scope/name": { filename, files, ... } }`. Notices may precede JSON.
 */
export function parseNpmPackJson(stdout: string): PackJsonResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const candidates = [objectStart, arrayStart].filter((index) => index >= 0);
  if (candidates.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(Math.min(...candidates)));
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) return asPackResult(parsed[0]);

  const direct = asPackResult(parsed);
  if (direct) return direct;

  if (!parsed || typeof parsed !== 'object') return undefined;
  for (const value of Object.values(parsed)) {
    const nested = asPackResult(value);
    if (nested) return nested;
  }
  return undefined;
}

export function listTarballEntryPaths(tarballPath: string): PackedFile[] {
  const listing = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  const files: PackedFile[] = [];
  for (const line of listing.split('\n')) {
    const entry = line.trim().replace(/\/$/, '');
    if (!entry || entry === 'package') continue;
    const packedPath = entry.replace(/^package\//, '');
    if (!packedPath) continue;
    files.push({ path: packedPath, size: 0 });
  }
  return files;
}

function readPackedPackageJson(tarballPath: string): Record<string, unknown> {
  const raw = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

function findPackedTarball(destDir: string, preferredFilename?: string): string | undefined {
  if (preferredFilename) {
    const preferred = path.join(destDir, path.basename(preferredFilename));
    if (fs.existsSync(preferred)) return preferred;
  }
  const matches = fs.readdirSync(destDir).filter((name) => name.endsWith('.tgz'));
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? path.join(destDir, only) : undefined;
}

function packPackage(
  pkgDirPath: string,
  destDir: string,
): { packData: PackJsonResult; tarballPath: string } {
  fs.mkdirSync(destDir, { recursive: true });
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', destDir], {
      cwd: pkgDirPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? stdout;
    stderr = failure.stderr ?? String(failure.message ?? err);
  }

  const parsed = parseNpmPackJson(stdout);
  const tarballPath = findPackedTarball(destDir, parsed?.filename);
  if (!tarballPath) {
    throw new Error(
      `npm pack produced no tarball in ${destDir}. stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`,
    );
  }

  const files = parsed?.files?.length ? parsed.files : listTarballEntryPaths(tarballPath);
  const packData: PackJsonResult = parsed
    ? { ...parsed, files, filename: path.basename(tarballPath) }
    : {
        id: '',
        name: '',
        version: '',
        filename: path.basename(tarballPath),
        size: fs.statSync(tarballPath).size,
        unpackedSize: 0,
        entryCount: files.length,
        files,
      };

  return { packData, tarballPath };
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
        const packed = packPackage(pkgDirPath, path.join(packDir, pkg.dirName));
        packData = packed.packData;
        packedManifest = readPackedPackageJson(packed.tarballPath);
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
