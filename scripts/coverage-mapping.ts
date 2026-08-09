#!/usr/bin/env bun
/**
 * Core engine for package coverage mapping, LCOV parsing, metric calculation,
 * and Shields.io endpoint badge JSON generation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PackageInfo {
  name: string; // e.g. "@di-framework/core"
  slug: string; // e.g. "core"
  dirName: string; // e.g. "di-framework-core"
  relPath: string; // e.g. "packages/di-framework-core"
  isMeasured: boolean;
  unmeasuredReason?: string;
}

export interface FileCoverageRecord {
  file: string;
  packageSlug: string | null;
  lf: number;
  lh: number;
  uncoveredLines: number[];
}

export interface PackageMetric {
  name: string;
  slug: string;
  dirName: string;
  relPath: string;
  isMeasured: boolean;
  unmeasuredReason?: string;
  lf: number;
  lh: number;
  percentage: number | null;
  status: string; // e.g. "100%", "N/A"
  badgeColor: string; // "brightgreen", "green", "yellowgreen", "yellow", "red", "lightgrey"
  badgeMessage: string; // "100%", "N/A"
}

export interface ShieldBadgeJson {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/**
 * Registry of packages that do not contain instrumented TypeScript source files.
 * These are handled explicitly and honestly (e.g. labeled as N/A) rather than
 * inheriting aggregate 100%.
 */
export const UNMEASURED_PACKAGES: Record<string, string> = {
  '@di-framework/tsc':
    'Contains Go plugin source (plugin/main.go) and CJS wrappers; no TypeScript source files instrumented by Bun LCOV runner.',
};

/**
 * Discovers all published packages under packages/ that have a package.json.
 */
export function getWorkspacePackages(packagesDir?: string): PackageInfo[] {
  const root = packagesDir || resolve(process.cwd(), 'packages');
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const packages: PackageInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(root, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const content = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (!content.name || !content.name.startsWith('@di-framework/')) continue;

      const name = content.name;
      const slug = name.replace('@di-framework/', '');
      const isMeasured = !(name in UNMEASURED_PACKAGES);

      packages.push({
        name,
        slug,
        dirName: entry.name,
        relPath: `packages/${entry.name}`,
        isMeasured,
        unmeasuredReason: UNMEASURED_PACKAGES[name],
      });
    } catch {
      // Ignore invalid package.json
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extracts package slug from a file path.
 */
export function getPackageSlugFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('examples/')) return null;
  const match =
    normalized.match(/(?:^|\/)packages\/di-framework-([^\/]+)\//) ||
    normalized.match(/(?:^|\/)packages\/([^\/]+)\//);
  if (!match || !match[1]) return null;
  const raw = match[1];
  return raw.startsWith('di-framework-') ? raw.replace('di-framework-', '') : raw;
}

/**
 * Checks if a file path is a valid production source file for line coverage.
 */
export function isSourceFile(filePath: string): boolean {
  const sf = filePath.replace(/\\/g, '/');
  if (!sf.startsWith('packages/') && !sf.includes('/packages/')) return false;
  if (sf.includes('examples/')) return false;
  if (
    sf.includes('/tests/') ||
    sf.includes('\\tests\\') ||
    sf.includes('/test/') ||
    sf.includes('\\test\\')
  )
    return false;
  if (sf.includes('/dist/') || sf.includes('\\dist\\')) return false;
  if (sf.endsWith('.test.ts') || sf.endsWith('.test.js') || sf.endsWith('.test.tsx'))
    return false;
  if (sf.endsWith('.spec.ts') || sf.endsWith('.spec.js') || sf.endsWith('.spec.tsx'))
    return false;
  if (sf.includes('preload-wasm-mock')) return false;
  if (sf.includes('/scripts/') || sf.includes('\\scripts\\')) return false;
  return sf.endsWith('.ts') || sf.endsWith('.js') || sf.endsWith('.tsx');
}

/**
 * Parses LCOV string content into per-file records.
 */
export function parseLcov(lcovContent: string): FileCoverageRecord[] {
  const records: FileCoverageRecord[] = [];
  for (const block of lcovContent.split('end_of_record')) {
    const lines = block.split('\n');
    const sfLine = lines.find((l) => l.startsWith('SF:'));
    if (!sfLine) continue;

    const file = sfLine.slice(3).trim();
    if (!isSourceFile(file)) continue;

    const packageSlug = getPackageSlugFromPath(file);
    const uncoveredLines: number[] = [];
    let hitsCount = 0;
    let totalCount = 0;

    for (const line of lines) {
      if (line.startsWith('DA:')) {
        const parts = line.slice(3).split(',');
        const lineno = Number(parts[0]);
        const hits = Number(parts[1]);
        totalCount++;
        if (hits > 0) {
          hitsCount++;
        } else {
          uncoveredLines.push(lineno);
        }
      }
    }

    records.push({
      file,
      packageSlug,
      lf: totalCount,
      lh: hitsCount,
      uncoveredLines,
    });
  }
  return records;
}

/**
 * Calculates per-package metrics given workspace packages and parsed LCOV records.
 */
export function calculatePackageMetrics(
  packages: PackageInfo[],
  records: FileCoverageRecord[]
): PackageMetric[] {
  return packages.map((pkg) => {
    if (!pkg.isMeasured) {
      return {
        ...pkg,
        lf: 0,
        lh: 0,
        percentage: null,
        status: 'N/A',
        badgeColor: 'lightgrey',
        badgeMessage: 'N/A',
      };
    }

    const pkgRecords = records.filter((r) => r.packageSlug === pkg.slug);
    const lf = pkgRecords.reduce((acc, r) => acc + r.lf, 0);
    const lh = pkgRecords.reduce((acc, r) => acc + r.lh, 0);

    if (lf === 0) {
      return {
        ...pkg,
        lf: 0,
        lh: 0,
        percentage: null,
        status: 'N/A',
        badgeColor: 'lightgrey',
        badgeMessage: 'N/A',
      };
    }

    const rawPct = (lh / lf) * 100;
    const pct = Number(rawPct.toFixed(1));
    const pctStr = pct === 100 ? '100%' : `${pct}%`;
    let color = 'brightgreen';
    if (pct < 60) color = 'red';
    else if (pct < 80) color = 'yellow';
    else if (pct < 95) color = 'yellowgreen';
    else if (pct < 100) color = 'green';

    return {
      ...pkg,
      lf,
      lh,
      percentage: pct,
      status: pctStr,
      badgeColor: color,
      badgeMessage: pctStr,
    };
  });
}

/**
 * Generates Shields.io endpoint badge JSON object.
 */
export function generateShieldBadgeJson(metric: PackageMetric): ShieldBadgeJson {
  return {
    schemaVersion: 1,
    label: 'coverage',
    message: metric.badgeMessage,
    color: metric.badgeColor,
  };
}
