import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS, nodeCompatibilityPlugin } from '../src/deps';
import {
  resolveRuntimeFile,
  rolldownInject,
  wasmcloudNodeEnv,
  wasmcloudUnenvPreset,
} from '../src/node-compat/env';
import {
  constants,
  existsSync,
  mkdirSync as guestMkdirSync,
  writeFileSync as guestWriteFileSync,
  readFileSync,
} from '../src/node-compat/fs';
import { builtinModules, createRequire } from '../src/node-compat/module';
import guestProcess, { cwd, env, nextTick } from '../src/node-compat/process';
import {
  collectProjectFiles,
  compactEnviron,
  createNodeCompatSeed,
  isNodeCompatSeedSource,
  MAX_SEEDED_FILE_BYTES,
  NODE_COMPAT_SEED_ID,
  renderNodeCompatSeedModule,
  toPosixGuestPath,
} from '../src/node-compat/seed';
import { nodeCompatSeed } from '../src/node-compat/seed-virtual';

afterEach(() => {
  nodeCompatSeed.files = {};
  nodeCompatSeed.environ = {};
  nodeCompatSeed.cwd = '/';
});

describe('guest memfs', () => {
  it('reads and writes utf8, reports ENOENT, and resolves relative paths', () => {
    guestWriteFileSync('/openapi.json', '{"ok":true}\n', 'utf8');
    expect(readFileSync('/openapi.json', 'utf8')).toBe('{"ok":true}\n');
    expect(readFileSync('/openapi.json', { encoding: 'utf8' })).toBe('{"ok":true}\n');
    expect(existsSync('/openapi.json')).toBe(true);
    expect(existsSync('/missing.json')).toBe(false);
    try {
      readFileSync('/missing.json', 'utf8');
      throw new Error('expected ENOENT');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ENOENT');
    }
    nodeCompatSeed.cwd = '/app';
    guestWriteFileSync('rel.txt', new Uint8Array([65]));
    expect(readFileSync('/app/rel.txt', 'utf8')).toBe('A');
    const raw = readFileSync('/app/rel.txt');
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(readFileSync('/app/rel.txt', {})).toBeInstanceOf(Uint8Array);
    expect(readFileSync('/app/rel.txt', { encoding: null })).toBeInstanceOf(Uint8Array);
    expect(constants.F_OK).toBe(0);
  });

  it('mkdirSync is recursive-or-EEXIST', () => {
    expect(guestMkdirSync('/out', { recursive: true })).toBe('/out');
    expect(guestMkdirSync('/out', { recursive: true })).toBeUndefined();
    expect(existsSync('/out')).toBe(true);
    guestMkdirSync('/mode', 0o755);
    expect(existsSync('/mode')).toBe(true);
    try {
      guestMkdirSync('/out');
      throw new Error('expected EEXIST');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EEXIST');
    }
  });
});

describe('guest process and module', () => {
  it('exposes cwd, a mutable env bag, and Object.entries', () => {
    expect(cwd()).toBe('/');
    expect(guestProcess.cwd()).toBe('/');
    expect(env.MISSING).toBeUndefined();
    env.APP_PORT = '3000';
    expect(env.APP_PORT).toBe('3000');
    expect(Object.entries(env)).toEqual([['APP_PORT', '3000']]);
    expect(Object.getOwnPropertyDescriptor(env, 'NOPE')).toBeUndefined();
    expect('APP_PORT' in env).toBe(true);
    delete env.APP_PORT;
    expect(env.APP_PORT).toBeUndefined();
    env.TMP = 'x';
    env.TMP = undefined;
    expect(env.TMP).toBeUndefined();
    expect(Reflect.get(env, Symbol('x'))).toBeUndefined();
    expect(Reflect.set(env, Symbol('y'), 'z')).toBe(true);
    let ticked = false;
    nextTick(() => {
      ticked = true;
    });
    return Promise.resolve().then(() => expect(ticked).toBe(true));
  });

  it('createRequire throws MODULE_NOT_FOUND', () => {
    const require = createRequire(import.meta.url);
    expect(() => require('yaml')).toThrow(/Cannot find module/);
    try {
      require('yaml');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MODULE_NOT_FOUND');
    }
    try {
      require.resolve('smol-toml');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MODULE_NOT_FOUND');
    }
    expect(require.cache).toEqual({});
    expect(builtinModules).toContain('fs');
  });
});

describe('node compat seed', () => {
  it('collects config files and skips tooling directories', () => {
    expect(collectProjectFiles(undefined)).toEqual({});
    expect(collectProjectFiles('/definitely-not-a-project-xyz')).toEqual({});
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-seed-'));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'di-framework.config.json'), '{"name":"app"}\n');
    writeFileSync(join(root, '.env'), 'A=1\n');
    writeFileSync(join(root, 'src', 'app.ts'), 'export default 1;\n');
    writeFileSync(join(root, 'node_modules', 'pkg.json'), '{}\n');
    writeFileSync(join(root, '.hidden', 'secret.json'), '{}\n');
    writeFileSync(join(root, 'notes.txt'), 'no\n');
    symlinkSync(join(root, 'di-framework.config.json'), join(root, 'link.json'));
    const files = collectProjectFiles(root);
    expect(files['/di-framework.config.json']).toContain('app');
    expect(files['/.env']).toBe('A=1\n');
    expect(files['/src/app.ts']).toBeUndefined();
    expect(files['/node_modules/pkg.json']).toBeUndefined();
    expect(toPosixGuestPath(`a${sep}b.json`)).toBe('/a/b.json');
  });

  it('skips oversized files and a non-directory root', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-seed-big-'));
    writeFileSync(join(root, 'tiny.json'), '{}\n');
    writeFileSync(join(root, 'huge.json'), 'x'.repeat(MAX_SEEDED_FILE_BYTES + 1));
    const files = collectProjectFiles(root);
    expect(files['/tiny.json']).toBe('{}\n');
    expect(files['/huge.json']).toBeUndefined();
    const capRoot = mkdtempSync(join(tmpdir(), 'wasmcloud-seed-cap-'));
    mkdirSync(join(capRoot, 'nested'), { recursive: true });
    const chunk = 'x'.repeat(MAX_SEEDED_FILE_BYTES);
    writeFileSync(join(capRoot, 'a.json'), chunk);
    writeFileSync(join(capRoot, 'b.json'), chunk);
    writeFileSync(join(capRoot, 'c.json'), chunk);
    writeFileSync(join(capRoot, 'd.json'), chunk);
    writeFileSync(join(capRoot, 'nested', 'e.json'), '{}\n');
    expect(Object.keys(collectProjectFiles(capRoot)).length).toBeLessThan(5);
    expect(collectProjectFiles(join(root, 'tiny.json'))).toEqual({});
    const unreadable = join(root, 'locked.json');
    writeFileSync(unreadable, '{}\n');
    chmodSync(unreadable, 0);
    collectProjectFiles(root);
    chmodSync(unreadable, 0o644);
  });

  it('compacts env, renders a seed module, and builds a seed object', () => {
    expect(compactEnviron(undefined)).toEqual({});
    expect(compactEnviron({ A: '1', B: undefined })).toEqual({ A: '1' });
    const seed = createNodeCompatSeed({
      files: { '/a.json': '{}' },
      env: { K: 'v', SKIP: undefined },
      cwd: '/app',
    });
    expect(seed).toEqual({ files: { '/a.json': '{}' }, environ: { K: 'v' }, cwd: '/app' });
    expect(createNodeCompatSeed({}).cwd).toBe('/');
    expect(renderNodeCompatSeedModule(seed)).toContain('"/a.json"');
    expect(isNodeCompatSeedSource('virtual:di-framework-node-fs-seed')).toBe(true);
    expect(isNodeCompatSeedSource('../seed-virtual.ts')).toBe(true);
    expect(isNodeCompatSeedSource('node:fs')).toBe(false);
    expect(NODE_COMPAT_SEED_ID).toContain('node-fs-seed');
  });
});

describe('unenv preset', () => {
  it('aliases framework Node built-ins and injects process/Buffer', () => {
    const envConfig = wasmcloudNodeEnv();
    expect(envConfig.alias['node:fs']).toMatch(/node-compat\/fs\.(ts|js)$/);
    expect(envConfig.alias['node:net']).toMatch(/node-compat\/net\.(ts|js)$/);
    expect(envConfig.alias['node:dgram']).toMatch(/node-compat\/dgram\.(ts|js)$/);
    expect(envConfig.alias['node:crypto']).toMatch(/node-compat\/crypto\.(ts|js)$/);
    expect(envConfig.alias['node:http']).toMatch(/node-compat\/http\.(ts|js)$/);
    expect(envConfig.alias['node:path']).toContain('unenv');
    expect(envConfig.alias['node:async_hooks']).toContain('unenv');
    expect(envConfig.inject.process?.[0]).toMatch(/node-compat\/process\.(ts|js)$/);
    expect(envConfig.inject.crypto?.[0]).toMatch(/node-compat\/crypto\.(ts|js)$/);
    expect(envConfig.inject.crypto?.[1]).toBe('webcrypto');
    expect(envConfig.polyfill.some((entry) => entry.includes('polyfill/process'))).toBe(false);
    expect(wasmcloudNodeEnv()).toBe(envConfig);
    const preset = wasmcloudUnenvPreset('/fs.js', '/process.js', '/module.js');
    expect(preset.alias?.['node:fs']).toBe('/fs.js');
    expect(
      rolldownInject({ Buffer: ['unenv/node/buffer', 'Buffer'], process: '/process.js' }),
    ).toEqual({
      Buffer: ['unenv/node/buffer', 'Buffer'],
      process: '/process.js',
    });
    expect(rolldownInject({ broken: ['only-one'] })).toEqual({});
    const jsDir = mkdtempSync(join(tmpdir(), 'wasmcloud-runtime-'));
    writeFileSync(join(jsDir, 'fs.js'), 'export {}\n');
    expect(resolveRuntimeFile(jsDir, 'fs')).toBe(join(jsDir, 'fs.js'));
    expect(resolveRuntimeFile(jsDir, 'missing')).toBe(join(jsDir, 'missing.ts'));
  });
});

describe('bundled Node contract', () => {
  it('runs fs, path, process, Buffer, ALS, and createRequire in a guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-node-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    const jsonFile = join(
      import.meta.dir,
      '..',
      '..',
      'di-framework-config',
      'src',
      'sources',
      'json-file.ts',
    );
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { jsonFileSource } from ${JSON.stringify(jsonFile)};
import { writeFileSync } from 'node:fs';

writeFileSync('/openapi.json', '{"ok":true}\\n', 'utf8');
let requireCode = 'ok';
try {
  createRequire(import.meta.url)('yaml');
} catch (error) {
  requireCode = (error as { code?: string }).code ?? 'none';
}
const als = new AsyncLocalStorage<number>();
export default {
  cwd: process.cwd(),
  abs: isAbsolute('/x'),
  joined: join('a', 'b'),
  resolved: resolve('/app', 'x'),
  config: jsonFileSource('/app.config.json').load(),
  optional: jsonFileSource('/missing.json', { optional: true }).load(),
  bytes: Buffer.byteLength('{"ok":true}\\n', 'utf8'),
  env: process.env.APP_PORT,
  requireCode,
  als: als.run(7, () => als.getStore()),
};
`,
    );
    await DEFAULT_DEPS.bundler({
      adapterPath,
      entryPath,
      outFile,
      files: { '/app.config.json': '{"port":8080}' },
      env: { APP_PORT: '3000' },
      cwd: '/',
    });
    const bundled = await import(pathToFileURL(outFile).href);
    expect(bundled.handler.cwd).toBe('/');
    expect(bundled.handler.abs).toBe(true);
    expect(bundled.handler.joined).toBe('a/b');
    expect(bundled.handler.config).toEqual({ port: 8080 });
    expect(bundled.handler.optional).toEqual({});
    expect(bundled.handler.bytes).toBeGreaterThan(0);
    expect(bundled.handler.env).toBe('3000');
    expect(bundled.handler.requireCode).toBe('MODULE_NOT_FOUND');
    expect(bundled.handler.als).toBe(7);
  });

  it('resolves node built-ins through the compatibility plugin', () => {
    const plugin = nodeCompatibilityPlugin('/project/src/app.ts');
    expect(plugin.resolveId('virtual:di-framework-application')).toBe('/project/src/app.ts');
    expect(plugin.resolveId('node:fs')).toMatch(/node-compat\/fs\.(ts|js)$/);
    expect(plugin.resolveId('node:net')).toMatch(/node-compat\/net\.(ts|js)$/);
    expect(plugin.resolveId('node:dgram')).toMatch(/node-compat\/dgram\.(ts|js)$/);
    expect(plugin.resolveId('node:crypto')).toMatch(/node-compat\/crypto\.(ts|js)$/);
    expect(plugin.resolveId('node:http')).toMatch(/node-compat\/http\.(ts|js)$/);
    expect(plugin.resolveId('node:path')).toContain('unenv');
    expect(plugin.resolveId('./seed-virtual.ts')).toBe(`\0${NODE_COMPAT_SEED_ID}`);
    expect(plugin.resolveId('rolldown')).toBeNull();
    expect(plugin.load('\0virtual:di-framework-node-fs-seed')).toContain('nodeCompatSeed');
    expect(plugin.load('/project/src/app.ts')).toBeNull();
  });
});
