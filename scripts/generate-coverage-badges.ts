#!/usr/bin/env bun
/**
 * Generates Shields.io endpoint badge JSON files in coverage/badges/<slug>.json
 * based on LCOV coverage metrics.
 *
 * Degrades gracefully when coverage/lcov.info is missing or when running in restricted environments
 * (e.g. PRs from forks or Dependabot without secrets).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  calculatePackageMetrics,
  generateShieldBadgeJson,
  getWorkspacePackages,
  parseLcov,
} from './coverage-mapping';

function main() {
  try {
    const cwd = process.cwd();
    const lcovPath = resolve(cwd, 'coverage/lcov.info');

    if (!existsSync(lcovPath)) {
      console.warn('[WARN] coverage/lcov.info not found. Skipping coverage badge generation.');
      process.exit(0);
    }

    const packages = getWorkspacePackages(resolve(cwd, 'packages'));
    const lcovContent = readFileSync(lcovPath, 'utf8');
    const records = parseLcov(lcovContent);
    const metrics = calculatePackageMetrics(packages, records);

    const badgesDir = resolve(cwd, 'coverage/badges');
    mkdirSync(badgesDir, { recursive: true });

    const summary: Record<string, unknown> = {};

    for (const metric of metrics) {
      const badgeJson = generateShieldBadgeJson(metric);
      const badgeFilePath = resolve(badgesDir, `${metric.slug}.json`);
      writeFileSync(badgeFilePath, JSON.stringify(badgeJson, null, 2) + '\n', 'utf8');

      summary[metric.slug] = {
        name: metric.name,
        slug: metric.slug,
        isMeasured: metric.isMeasured,
        coverage: metric.status,
        lh: metric.lh,
        lf: metric.lf,
        badge: badgeJson,
      };
    }

    writeFileSync(
      resolve(badgesDir, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
      'utf8',
    );

    console.log(
      `[SUCCESS] Generated coverage badge JSON files for ${metrics.length} package(s) in coverage/badges/`,
    );
  } catch (err) {
    console.warn(
      `[WARN] Coverage badge generation encountered a non-fatal error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Degrade gracefully for forks / Dependabot
    process.exit(0);
  }
}

main();
