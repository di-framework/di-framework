import { describe, expect, it } from 'bun:test';
import {
  frameworkInternalRange,
  frameworkMajor,
  INTERNAL_CROSS_MAJOR_ALLOWLIST,
  preparePublishManifest,
  rangeAcceptsRelease,
  validateInternalFrameworkDeps,
} from '../packages/di-framework-cli/scripts/internal-framework-deps';

describe('internal framework dependency ranges', () => {
  it('derives the framework major from the release version', () => {
    expect(frameworkMajor('5.2.0')).toBe(5);
    expect(frameworkMajor('v6.0.0')).toBe(6);
    expect(frameworkInternalRange('5.2.0')).toBe('^5');
    expect(frameworkInternalRange('6.1.3')).toBe('^6');
  });

  it('rejects stale ^4 peer ranges for a 5.x release', () => {
    const issues = validateInternalFrameworkDeps(
      {
        name: '@di-framework/auth',
        peerDependencies: {
          '@di-framework/core': '^4',
          '@di-framework/http': '^4',
          typescript: '^5',
        },
      },
      '5.2.0',
    );

    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.map((i) => i.dependency)).toContain('@di-framework/core');
    expect(issues.map((i) => i.dependency)).toContain('@di-framework/http');
    expect(rangeAcceptsRelease('^4', '5.2.0')).toBe(false);
  });

  it('accepts aligned ^5 ranges for a 5.x release', () => {
    const issues = validateInternalFrameworkDeps(
      {
        name: '@di-framework/auth',
        dependencies: {
          '@di-framework/codegen': '^5',
        },
        optionalDependencies: {},
        peerDependencies: {
          '@di-framework/core': '^5',
          '@di-framework/http': '^5',
          '@di-framework/graphql': '^5',
          '@di-framework/repo': '^5',
          typescript: '^5',
        },
      },
      '5.2.0',
    );

    expect(issues).toEqual([]);
    expect(rangeAcceptsRelease('^5', '5.2.0')).toBe(true);
  });

  it('preparePublishManifest rewrites stale and workspace internal ranges to ^major', () => {
    const prepared = preparePublishManifest(
      {
        name: '@di-framework/config',
        version: '5.2.0',
        peerDependencies: {
          '@di-framework/core': '^4',
          typescript: '^5',
        },
        dependencies: {
          '@di-framework/core': 'workspace:*',
        },
      },
      '5.2.0',
    );

    expect(prepared.peerDependencies?.['@di-framework/core']).toBe('^5');
    expect(prepared.dependencies?.['@di-framework/core']).toBe('^5');
    expect(prepared.peerDependencies?.typescript).toBe('^5');
    expect(validateInternalFrameworkDeps(prepared, '5.2.0')).toEqual([]);
  });

  it('allowlists the wasmtime-48 componentize-qjs fork', () => {
    expect(
      INTERNAL_CROSS_MAJOR_ALLOWLIST.has(
        '@di-framework/cli-plugin-wasmcloud>@di-framework/componentize-qjs',
      ),
    ).toBe(true);
    const manifest = {
      name: '@di-framework/cli-plugin-wasmcloud',
      dependencies: { '@di-framework/componentize-qjs': '0.4.4-di.1' },
    };
    expect(validateInternalFrameworkDeps(manifest, '5.2.9')).toEqual([]);
    expect(
      preparePublishManifest(manifest, '5.2.9').dependencies?.['@di-framework/componentize-qjs'],
    ).toBe('0.4.4-di.1');
  });

  it('honors the documented cross-major allowlist', () => {
    const key = '@di-framework/test-consumer>@di-framework/core';
    expect(INTERNAL_CROSS_MAJOR_ALLOWLIST.has(key)).toBe(false);

    INTERNAL_CROSS_MAJOR_ALLOWLIST.add(key);
    try {
      const issues = validateInternalFrameworkDeps(
        {
          name: '@di-framework/test-consumer',
          peerDependencies: { '@di-framework/core': '^4' },
        },
        '5.2.0',
      );
      expect(issues).toEqual([]);

      const prepared = preparePublishManifest(
        {
          name: '@di-framework/test-consumer',
          peerDependencies: { '@di-framework/core': '^4' },
        },
        '5.2.0',
      );
      expect(prepared.peerDependencies?.['@di-framework/core']).toBe('^4');
    } finally {
      INTERNAL_CROSS_MAJOR_ALLOWLIST.delete(key);
    }
  });
});
