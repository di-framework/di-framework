import { describe, expect, it } from 'bun:test';
import { parseNpmPackJson } from '../scripts/check-package-tarballs';

describe('parseNpmPackJson', () => {
  const sample = {
    id: '@di-framework/http@5.2.1',
    name: '@di-framework/http',
    version: '5.2.1',
    filename: 'di-framework-http-5.2.1.tgz',
    size: 100,
    unpackedSize: 200,
    entryCount: 1,
    files: [{ path: 'package.json', size: 10 }],
  };

  it('accepts npm 10 array output', () => {
    expect(parseNpmPackJson(JSON.stringify([sample]))).toEqual(sample);
  });

  it('accepts npm 11 object output', () => {
    expect(parseNpmPackJson(JSON.stringify(sample))?.filename).toBe('di-framework-http-5.2.1.tgz');
  });

  it('skips leading npm notices before JSON', () => {
    const stdout = `npm notice\n${JSON.stringify(sample)}`;
    expect(parseNpmPackJson(stdout)?.filename).toBe('di-framework-http-5.2.1.tgz');
  });

  it('returns undefined for empty array or missing filename (CI bun/npm 11)', () => {
    expect(parseNpmPackJson('[]')).toBeUndefined();
    expect(parseNpmPackJson('{}')).toBeUndefined();
    expect(parseNpmPackJson('')).toBeUndefined();
  });
});
