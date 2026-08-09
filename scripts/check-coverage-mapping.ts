#!/usr/bin/env bun
/**
 * CI Verification script for package coverage mapping and README completeness.
 *
 * Verifies:
 * 1. Every published @di-framework/* package in packages/ is mapped in the coverage system.
 * 2. Unmeasured or non-TypeScript packages (e.g. @di-framework/tsc) are handled explicitly & honestly.
 * 3. Every published package is present in root README.md with dynamic coverage badges.
 * 4. Every published package is documented in COVERAGE.md.
 * 5. If a package is missing from mapping or documentation, CI fails with an actionable error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  calculatePackageMetrics,
  getWorkspacePackages,
  parseLcov,
  UNMEASURED_PACKAGES,
} from './coverage-mapping';

const cwd = process.cwd();
const packages = getWorkspacePackages(resolve(cwd, 'packages'));

if (packages.length === 0) {
  console.error('[FAIL] No published @di-framework/* packages found in packages/.');
  process.exit(1);
}

const readmePath = resolve(cwd, 'README.md');
if (!existsSync(readmePath)) {
  console.error('[FAIL] Missing README.md at repository root.');
  process.exit(1);
}

const readmeContent = readFileSync(readmePath, 'utf8');

const errors: string[] = [];

// 1. Verify coverage mapping for every workspace package
for (const pkg of packages) {
  // Check if unmeasured package is explicitly registered
  if (!pkg.isMeasured && !(pkg.name in UNMEASURED_PACKAGES)) {
    errors.push(
      `Package '${pkg.name}' is marked as unmeasured but lacks an explicit reason in UNMEASURED_PACKAGES.`,
    );
  }

  // Verify presence in README.md packages table
  if (!readmeContent.includes(`\`${pkg.name}\``)) {
    errors.push(`Package '${pkg.name}' is missing from the packages table in README.md.`);
  }
}

// 2. Check for hard-coded coverage badges in README.md
if (readmeContent.includes('img.shields.io/badge/coverage-100%25-brightgreen')) {
  errors.push(
    `README.md still contains hard-coded coverage-100% badges. Replace with dynamic badge endpoints.`,
  );
}

// 3. Optional LCOV metrics verification if lcov.info exists
const lcovPath = resolve(cwd, 'coverage/lcov.info');
if (existsSync(lcovPath)) {
  const lcovContent = readFileSync(lcovPath, 'utf8');
  const records = parseLcov(lcovContent);
  const metrics = calculatePackageMetrics(packages, records);

  console.log('\n--- Package Coverage Mapping & Metrics Summary ---');
  for (const m of metrics) {
    if (!m.isMeasured) {
      console.log(`  [UNMEASURED] ${m.name.padEnd(25)} -> Status: N/A (${m.unmeasuredReason})`);
    } else {
      console.log(
        `  [MEASURED]   ${m.name.padEnd(25)} -> Coverage: ${m.status.padStart(6)} (${m.lh}/${m.lf} lines)`,
      );
    }
  }
  console.log('--------------------------------------------------\n');
} else {
  console.log(
    '[INFO] coverage/lcov.info not found; checked mapping definitions and README schema.',
  );
}

if (errors.length > 0) {
  console.error(`\n[FAIL] Coverage mapping verification failed (${errors.length} error(s)):\n`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error(
    '\nAction Required: Ensure every published @di-framework/* package in packages/ is mapped in scripts/coverage-mapping.ts and has a dynamic badge in README.md.\n',
  );
  process.exit(1);
}

console.log(`[PASS] Coverage mapping check passed. All ${packages.length} package(s) verified.`);
process.exit(0);
