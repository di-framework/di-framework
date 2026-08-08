import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('@di-framework/tsc plugin entry', () => {
  it('exports a factory that points at the Go plugin source', () => {
    const createPlugin = require(join(pkgRoot, 'plugin.cjs')) as (ctx: { dirname: string }) => {
      name: string;
      source: string;
      stage: string;
    };

    const plugin = createPlugin({ dirname: pkgRoot });
    expect(plugin.name).toBe('@di-framework/tsc');
    expect(plugin.stage).toBe('transform');
    expect(plugin.source).toBe(join(pkgRoot, 'plugin'));
  });

  it('declares package metadata expected by the monorepo', async () => {
    // @ts-expect-error - Property 'json' does not exist on type 'BunFile'.
    const pkg = (await Bun.file(join(pkgRoot, 'package.json')).json()) as {
      name: string;
      main: string;
      scripts: Record<string, string>;
      repository: { directory: string };
    };
    expect(pkg.name).toBe('@di-framework/tsc');
    expect(pkg.main).toBe('plugin.cjs');
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.repository.directory).toBe('packages/di-framework-tsc');
  });
});
