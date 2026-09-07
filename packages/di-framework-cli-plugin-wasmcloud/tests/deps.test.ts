import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DEPS, findJcoEntry, nodeCompatibilityPlugin } from '../src/deps';

describe('nodeCompatibilityPlugin', () => {
  it('routes the virtual application module and stubs node built-ins', () => {
    const plugin = nodeCompatibilityPlugin('/project/src/app.ts');
    expect(plugin.resolveId('virtual:di-framework-application')).toBe('/project/src/app.ts');
    expect(plugin.resolveId('node:fs')).toBe('\0node:fs');
    expect(plugin.resolveId('node:path')).toBe('\0node:path');
    expect(plugin.resolveId('rolldown')).toBeNull();
    expect(plugin.load('\0node:fs')).toContain('unavailable in a WebAssembly component');
    expect(plugin.load('\0node:path')).toContain('isAbsolute');
    expect(plugin.load('/project/src/app.ts')).toBeNull();
    expect(plugin.resolveId('virtual:di-framework-wasmcloud-guests')).toBe(
      '\0virtual:di-framework-wasmcloud-guests-empty',
    );
    expect(plugin.load('\0virtual:di-framework-wasmcloud-guests-empty')).toContain('guests');
    expect(
      nodeCompatibilityPlugin('/app.ts', '/generated/guests.js').resolveId(
        'virtual:di-framework-wasmcloud-guests',
      ),
    ).toBe('/generated/guests.js');
  });
});

describe('DEFAULT_DEPS', () => {
  it('runs processes and reports their exit codes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wasmcloud-deps-'));
    const ok = await DEFAULT_DEPS.runner(process.execPath, ['--version'], { cwd });
    expect(ok.exitCode).toBe(0);
    const failed = await DEFAULT_DEPS.runner(process.execPath, ['-e', 'process.exit(3)'], {
      cwd,
      env: process.env,
    });
    expect(failed.exitCode).toBe(3);
  });

  it('captures probe output and reports unavailable commands', () => {
    expect(DEFAULT_DEPS.capture(process.execPath, ['--version'])).toMatch(/\d+\.\d+/);
    expect(DEFAULT_DEPS.capture('definitely-not-a-command-xyz', [])).toBeUndefined();
    expect(DEFAULT_DEPS.capture(process.execPath, ['-e', 'process.exit(1)'])).toBeUndefined();
  });

  it('captures stdout, stderr, and the exit code of a child process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wasmcloud-deps-capture-'));
    const captured = await DEFAULT_DEPS.runCaptured(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(4)'],
      { cwd },
    );
    expect(captured.exitCode).toBe(4);
    expect(captured.stdout).toBe('out');
    expect(captured.stderr).toBe('err');

    const withEnv = await DEFAULT_DEPS.runCaptured(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.WASM_CLOUD_DEPS_TEST ?? "")'],
      { cwd, env: { ...process.env, WASM_CLOUD_DEPS_TEST: 'from-env' } },
    );
    expect(withEnv.stdout).toBe('from-env');
    await DEFAULT_DEPS.wait(1);
  });

  it('bundles an entry behind an adapter with the compatibility plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      "import { writeFileSync } from 'node:fs';\nimport { isAbsolute, resolve } from 'node:path';\nexport default `${isAbsolute(resolve('x'))}:${typeof writeFileSync}`;\n",
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, 'utf8')).toContain('handler');
  });

  it('leaves wasi and wasmcloud WIT specifiers as component imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-bundle-ext-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import { handle } from 'wasi:http/handler@0.3.0';\nimport { query } from 'wasmcloud:postgres/query@0.2.0';\nexport const handler = { handle, query };\n",
    );
    writeFileSync(entryPath, 'export default 1;\n');
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const bundled = readFileSync(outFile, 'utf8');
    expect(bundled).toContain('wasi:http/handler@0.3.0');
    expect(bundled).toContain('wasmcloud:postgres/query@0.2.0');
  });

  it('locates the jco CLI, shipped assets, and project resolutions', () => {
    // A node_modules path (not bun's install cache) so Node can run jco directly.
    expect(DEFAULT_DEPS.jcoCliPath()).toEndWith(
      join('node_modules', '@bytecodealliance', 'jco', 'dist', 'jco.js'),
    );
    expect(findJcoEntry(mkdtempSync(join(tmpdir(), 'wasmcloud-nojco-')))).toBeUndefined();
    expect(['string', 'undefined']).toContain(typeof DEFAULT_DEPS.nodeBinaryPath());
    expect(DEFAULT_DEPS.assetsDirectory()).toEndWith(join('dist', 'assets'));
    expect(DEFAULT_DEPS.env).toBe(process.env);
    expect(DEFAULT_DEPS.cwd()).toBe(process.cwd());

    const packageRoot = join(import.meta.dir, '..');
    expect(DEFAULT_DEPS.resolveFromProject(packageRoot, 'rolldown')).toBeDefined();
    expect(
      DEFAULT_DEPS.resolveFromProject(packageRoot, '@definitely/not-installed-xyz'),
    ).toBeUndefined();
  });
});
