import { describe, expect, test } from 'bun:test';
import { normalizeDocsVersion, parseVersionFromUrl, parseVersionToken } from './docs-version';

describe('docs version tokens', () => {
  test('parses latest aliases and minor tags', () => {
    expect(parseVersionToken('latest')).toBe('latest');
    expect(parseVersionToken('current')).toBe('latest');
    expect(parseVersionToken('v4.2')).toBe('v4.2');
    expect(parseVersionToken('4.1.9')).toBe('v4.1');
    expect(parseVersionToken('d')).toBeUndefined();
  });

  test('reads the version from a docs URL or Referer', () => {
    expect(parseVersionFromUrl('https://docs.di-framework.dev/v4.1/overview.html')).toBe('v4.1');
    expect(parseVersionFromUrl('https://docs.di-framework.dev/latest/overview.html')).toBe(
      'latest',
    );
    expect(parseVersionFromUrl('https://docs.di-framework.dev/overview.html')).toBeUndefined();
    expect(parseVersionFromUrl('/v4.2/overview.html')).toBe('v4.2');
    expect(
      normalizeDocsVersion(undefined, 'https://docs.di-framework.dev/v4.2/repositories.html'),
    ).toBe('v4.2');
    expect(normalizeDocsVersion(undefined, undefined)).toBe('latest');
  });
});
