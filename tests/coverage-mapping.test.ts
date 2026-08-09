import { describe, expect, it } from 'bun:test';
import {
  calculatePackageMetrics,
  generateShieldBadgeJson,
  getPackageSlugFromPath,
  getWorkspacePackages,
  isSourceFile,
  parseLcov,
  UNMEASURED_PACKAGES,
} from '../scripts/coverage-mapping';

describe('Coverage LCOV Parsing & Package Mapping', () => {
  it('discovers all published workspace packages under packages/', () => {
    const packages = getWorkspacePackages();
    expect(packages.length).toBeGreaterThanOrEqual(14);

    const names = packages.map((p) => p.name);
    expect(names).toContain('@di-framework/core');
    expect(names).toContain('@di-framework/cli');
    expect(names).toContain('@di-framework/codegen');
    expect(names).toContain('@di-framework/tsc');
    expect(names).toContain('@di-framework/repo');
    expect(names).toContain('@di-framework/http');
    expect(names).toContain('@di-framework/graphql');
    expect(names).toContain('@di-framework/events');
    expect(names).toContain('@di-framework/config');
    expect(names).toContain('@di-framework/auth');
    expect(names).toContain('@di-framework/authz');
    expect(names).toContain('@di-framework/socket');
    expect(names).toContain('@di-framework/rpc');
    expect(names).toContain('@di-framework/ai');
  });

  it('correctly classifies unmeasured packages like @di-framework/tsc', () => {
    const packages = getWorkspacePackages();
    const tscPkg = packages.find((p) => p.name === '@di-framework/tsc');
    expect(tscPkg).toBeDefined();
    expect(tscPkg?.isMeasured).toBe(false);
    expect(tscPkg?.unmeasuredReason).toBe(UNMEASURED_PACKAGES['@di-framework/tsc']);
  });

  it('extracts package slugs from file paths', () => {
    expect(getPackageSlugFromPath('packages/di-framework-core/container.ts')).toBe('core');
    expect(getPackageSlugFromPath('packages/di-framework-auth/src/webauthn/service.ts')).toBe(
      'auth',
    );
    expect(getPackageSlugFromPath('packages/di-framework-cli/cmd/build.ts')).toBe('cli');
    expect(getPackageSlugFromPath('packages/di-framework-codegen/index.ts')).toBe('codegen');
    expect(getPackageSlugFromPath('examples/packages/basic/index.ts')).toBeNull();
  });

  it('correctly filters source files vs test/dist/script files', () => {
    expect(isSourceFile('packages/di-framework-core/container.ts')).toBe(true);
    expect(isSourceFile('packages/di-framework-auth/src/authorization.ts')).toBe(true);
    expect(isSourceFile('packages/di-framework-core/tests/container.test.ts')).toBe(false);
    expect(isSourceFile('packages/di-framework-core/dist/index.js')).toBe(false);
    expect(isSourceFile('packages/di-framework-ai/tests/preload-wasm-mock.ts')).toBe(false);
    expect(isSourceFile('scripts/check-line-coverage.ts')).toBe(false);
    expect(isSourceFile('examples/packages/basic/index.ts')).toBe(false);
  });

  it('parses LCOV blocks and aggregates line hits and line counts', () => {
    const mockLcov = `
TN:
SF:packages/di-framework-core/container.ts
DA:1,10
DA:2,5
DA:3,0
LF:3
LH:2
end_of_record
TN:
SF:packages/di-framework-core/tests/container.test.ts
DA:1,1
LF:1
LH:1
end_of_record
TN:
SF:packages/di-framework-auth/src/service.ts
DA:10,3
DA:11,3
LF:2
LH:2
end_of_record
`;

    const records = parseLcov(mockLcov);
    expect(records.length).toBe(2);

    const coreRecord = records.find((r) => r.file.includes('core/container.ts'));
    expect(coreRecord).toBeDefined();
    expect(coreRecord?.lf).toBe(3);
    expect(coreRecord?.lh).toBe(2);
    expect(coreRecord?.uncoveredLines).toEqual([3]);

    const authRecord = records.find((r) => r.file.includes('auth/src/service.ts'));
    expect(authRecord).toBeDefined();
    expect(authRecord?.lf).toBe(2);
    expect(authRecord?.lh).toBe(2);
    expect(authRecord?.uncoveredLines).toEqual([]);
  });

  it('calculates package metrics with percentage and badge colors', () => {
    const packages = [
      {
        name: '@di-framework/core',
        slug: 'core',
        dirName: 'di-framework-core',
        relPath: 'packages/di-framework-core',
        isMeasured: true,
      },
      {
        name: '@di-framework/auth',
        slug: 'auth',
        dirName: 'di-framework-auth',
        relPath: 'packages/di-framework-auth',
        isMeasured: true,
      },
      {
        name: '@di-framework/tsc',
        slug: 'tsc',
        dirName: 'di-framework-tsc',
        relPath: 'packages/di-framework-tsc',
        isMeasured: false,
        unmeasuredReason: 'Go plugin',
      },
    ];

    const records = [
      {
        file: 'packages/di-framework-core/c1.ts',
        packageSlug: 'core',
        lf: 100,
        lh: 100,
        uncoveredLines: [],
      },
      {
        file: 'packages/di-framework-auth/a1.ts',
        packageSlug: 'auth',
        lf: 100,
        lh: 80,
        uncoveredLines: [1, 2],
      },
    ];

    const metrics = calculatePackageMetrics(packages, records);
    expect(metrics.length).toBe(3);

    const coreMetric = metrics.find((m) => m.slug === 'core');
    expect(coreMetric?.percentage).toBe(100);
    expect(coreMetric?.status).toBe('100%');
    expect(coreMetric?.badgeColor).toBe('brightgreen');

    const authMetric = metrics.find((m) => m.slug === 'auth');
    expect(authMetric?.percentage).toBe(80);
    expect(authMetric?.status).toBe('80%');
    expect(authMetric?.badgeColor).toBe('yellowgreen');

    const tscMetric = metrics.find((m) => m.slug === 'tsc');
    expect(tscMetric?.percentage).toBeNull();
    expect(tscMetric?.status).toBe('N/A');
    expect(tscMetric?.badgeColor).toBe('lightgrey');
  });

  it('generates valid Shields endpoint badge JSON schema', () => {
    const metric = {
      name: '@di-framework/core',
      slug: 'core',
      dirName: 'di-framework-core',
      relPath: 'packages/di-framework-core',
      isMeasured: true,
      lf: 50,
      lh: 50,
      percentage: 100,
      status: '100%',
      badgeColor: 'brightgreen',
      badgeMessage: '100%',
    };

    const shieldJson = generateShieldBadgeJson(metric);
    expect(shieldJson).toEqual({
      schemaVersion: 1,
      label: 'coverage',
      message: '100%',
      color: 'brightgreen',
    });
  });
});
