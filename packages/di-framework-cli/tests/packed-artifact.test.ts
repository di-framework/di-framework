import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_ROOT = join(REPO_ROOT, 'packages', 'di-framework-cli');

function writeWasmcloudFixture(projectRoot: string): void {
  const packageName = '@di-framework/cli-plugin-wasmcloud';
  const packageRoot = join(projectRoot, 'node_modules', '@di-framework', 'cli-plugin-wasmcloud');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      name: 'packed-cli-smoke',
      private: true,
      dependencies: { [packageName]: '1.0.0' },
    })}\n`,
  );
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: 'index.js' })}\n`,
  );
  writeFileSync(
    join(packageRoot, 'index.js'),
    `export default {
  schemaVersion: 1,
  name: 'wasmcloud',
  description: 'Packed artifact smoke extension',
  command: {
    description: 'Packed artifact smoke extension',
    children: {
      doctor: {
        description: 'Check readiness',
        run: () => ({ data: { ready: true } }),
      },
    },
  },
};
`,
  );
}

describe('packed CLI artifact', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('starts, loads maintainer code, and dispatches an extension after installation', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'packed-cli-smoke-'));
    temps.push(projectRoot);
    const packRoot = join(projectRoot, 'pack');
    mkdirSync(packRoot, { recursive: true });

    execFileSync('npm', ['pack', '--json', '--pack-destination', packRoot], {
      cwd: CLI_ROOT,
      stdio: 'pipe',
    });
    const tarball = readdirSync(packRoot).find((name) => name.endsWith('.tgz'));
    expect(tarball).toBeDefined();

    const installedCli = join(projectRoot, 'node_modules', '@di-framework', 'cli');
    mkdirSync(installedCli, { recursive: true });
    execFileSync(
      'tar',
      ['-xzf', join(packRoot, tarball as string), '--strip-components=1', '-C', installedCli],
      { stdio: 'pipe' },
    );

    // Supply the already-installed workspace dependencies without letting the
    // source CLI itself participate in module resolution.
    const installedScope = join(projectRoot, 'node_modules', '@di-framework');
    const dependencySources = {
      'cli-extension': join(CLI_ROOT, 'node_modules', '@di-framework', 'cli-extension'),
      codegen: join(CLI_ROOT, 'node_modules', '@di-framework', 'codegen'),
      http: join(REPO_ROOT, 'packages', 'di-framework-http'),
    };
    for (const [name, source] of Object.entries(dependencySources)) {
      symlinkSync(source, join(installedScope, name));
    }
    symlinkSync(
      join(REPO_ROOT, 'node_modules', 'typescript'),
      join(projectRoot, 'node_modules', 'typescript'),
    );
    writeWasmcloudFixture(projectRoot);

    const run = (...args: string[]) =>
      spawnSync('bun', [join(installedCli, 'main.ts'), ...args], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, DI_FRAMEWORK_EXTENSIONS_DIR: join(projectRoot, 'empty-store') },
      });

    const help = run('--help');
    expect({ status: help.status, stderr: help.stderr }).toEqual({ status: 0, stderr: '' });
    expect(help.stdout).toContain('di-framework <command>');

    // Invalid arguments stop before publishing, but only after the lazy module and
    // its packaged internal-framework-deps helper have both been resolved.
    const publish = run('mx', 'publish', 'unexpected');
    expect(publish.status).toBe(2);
    expect(publish.stderr).toContain('mx publish does not accept arguments');

    const extension = run('wasmcloud', 'doctor', '--json');
    expect(extension.status).toBe(0);
    expect(JSON.parse(extension.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'wasmcloud doctor',
      ok: true,
      data: { ready: true },
    });
  }, 30_000);
});
