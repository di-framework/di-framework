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

  it('accepts npm latest keyed-by-package-name output', () => {
    expect(parseNpmPackJson(JSON.stringify({ [sample.name]: sample }))).toEqual(sample);
  });

  it('skips non-pack values in a name-keyed map', () => {
    expect(parseNpmPackJson(JSON.stringify({ skip: {}, [sample.name]: sample }))).toEqual(sample);
    expect(parseNpmPackJson(JSON.stringify({ skip: [], [sample.name]: sample }))).toEqual(sample);
    expect(parseNpmPackJson(JSON.stringify({ '@di-framework/ai': { name: 'x' } }))).toBeUndefined();
  });

  it('skips leading npm notices before JSON', () => {
    const stdout = `npm notice\n${JSON.stringify(sample)}`;
    expect(parseNpmPackJson(stdout)?.filename).toBe('di-framework-http-5.2.1.tgz');
  });

  it('returns undefined for empty array or missing filename (CI bun/npm 11)', () => {
    expect(parseNpmPackJson('[]')).toBeUndefined();
    expect(parseNpmPackJson('{}')).toBeUndefined();
    expect(parseNpmPackJson('')).toBeUndefined();
    expect(parseNpmPackJson('{not-json')).toBeUndefined();
    expect(parseNpmPackJson('npm notice only')).toBeUndefined();
  });

  it('defaults missing pack fields when filename is present', () => {
    expect(parseNpmPackJson(JSON.stringify({ filename: 'pkg.tgz', files: 'nope' }))).toEqual({
      id: '',
      name: '',
      version: '',
      filename: 'pkg.tgz',
      size: 0,
      unpackedSize: 0,
      entryCount: 0,
      files: [],
    });
  });
});

it('skips private applications while enforcing published package contents', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'private-pack-audit-'));
  const audit = resolve(import.meta.dir, '../scripts/check-package-tarballs.ts');
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'workspace', version: '5.3.3', private: true }),
    );
    const dir = join(root, 'packages', 'private-app');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const manifest = {
      name: '@di-framework/private-app',
      version: '5.3.3',
      private: true,
      exports: './src/index.ts',
      dependencies: { '@di-framework/core': 'workspace:*' },
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'src/index.ts'), 'export const app = true;');
    const run = async () => {
      const process = Bun.spawn([Bun.which('bun')!, audit], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { output: stdout + stderr, exitCode };
    };
    expect((await run()).exitCode).toBe(0);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...manifest, private: false }));
    const published = await run();
    expect(published.exitCode).toBe(1);
    expect(published.output).toContain('unresolved protocol "workspace:*"');
    expect(published.output).toContain('forbidden raw TypeScript source file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
