import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { emptyGuestsModule } from './guests.js';

export type ProcessRunOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
};

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<{ exitCode: number }>;

export type CapturedProcess = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CapturedRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<CapturedProcess>;

/** First output line of a probe command, or undefined when it is unavailable. */
export type CaptureRunner = (command: string, args: readonly string[]) => string | undefined;

export type BundleOptions = {
  adapterPath: string;
  entryPath: string;
  outFile: string;
  guestsPath?: string;
};

export type Bundler = (options: BundleOptions) => Promise<void>;

/** Component imports are WIT specifiers, not npm packages. */
export const COMPONENT_IMPORT_EXTERNAL = /^(wasi|wasmcloud):/;

/** Every process, filesystem-adjacent, and toolchain boundary the commands touch. */
export type WasmcloudDeps = {
  runner: ProcessRunner;
  capture: CaptureRunner;
  /** Captures stdout/stderr for tools whose output the CLI must parse. */
  runCaptured: CapturedRunner;
  wait(ms: number): Promise<void>;
  bundler: Bundler;
  jcoCliPath(): string;
  /**
   * Optional componentize-qjs CLI built against wasmtime 48+ with
   * `concurrency_support`. Resolved from `DI_FRAMEWORK_COMPONENTIZE_QJS`,
   * `@di-framework/componentize-qjs`, or `PATH`. Stock jco 1.32.1 uses
   * wasmtime 47, which cannot stub imported `async func`s during wizer.
   */
  componentizeQjsPath(): string | undefined;
  /** jco needs real Node.js; it uses node internals Bun does not implement. */
  nodeBinaryPath(): string | undefined;
  /** wasmtime serve hosts WASI 0.3 HTTP components locally. */
  wasmtimeBinaryPath(): string | undefined;
  washBinaryPath(): string | undefined;
  assetsDirectory(): string;
  resolveFromProject(projectRoot: string, specifier: string): string | undefined;
  env: Record<string, string | undefined>;
  cwd(): string;
};

/** Resolves `virtual:di-framework-application` to the app entry and stubs node built-ins. */
export function nodeCompatibilityPlugin(entryPath: string, guestsPath?: string) {
  return {
    name: 'di-framework-component-runtime',
    resolveId(source: string) {
      if (source === 'virtual:di-framework-application') return entryPath;
      if (source === 'virtual:di-framework-wasmcloud-guests') {
        return guestsPath ?? '\0virtual:di-framework-wasmcloud-guests-empty';
      }
      if (source === 'node:fs' || source === 'node:path') return `\0${source}`;
      return null;
    },
    load(id: string) {
      if (id === '\0virtual:di-framework-wasmcloud-guests-empty') return emptyGuestsModule();
      if (id === '\0node:fs') {
        return "export const writeFileSync = () => { throw new Error('node:fs is unavailable in a WebAssembly component'); };";
      }
      if (id === '\0node:path') {
        return 'export const isAbsolute = () => false; export const resolve = value => value;';
      }
      return null;
    },
  };
}

/** Points at a wasmtime-48+ componentize-qjs CLI that can stub imported `async func`s. */
export const COMPONENTIZE_QJS_ENV = 'DI_FRAMEWORK_COMPONENTIZE_QJS';

/** npm wrapper that selects the matching optional platform CLI package. */
export const COMPONENTIZE_QJS_PACKAGE = '@di-framework/componentize-qjs';

// Real path, not a store symlink, so walking up reaches this package's node_modules.
const packageRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

export function componentizeQjsPlatformPackageName(
  platform = process.platform,
  arch = process.arch,
): string {
  return `${COMPONENTIZE_QJS_PACKAGE}-${platform}-${arch}`;
}

/**
 * Locate the native CLI shipped by `@di-framework/componentize-qjs-<os>-<arch>`.
 * Walks `node_modules` from `startDirectory` (same strategy as `findJcoEntry`)
 * so Bun's install cache is not required.
 */
export function findInstalledComponentizeQjsCli(
  startDirectory = packageRoot,
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  const scopedDirectory = `componentize-qjs-${platform}-${arch}`;
  const binName = platform === 'win32' ? 'componentize-qjs.exe' : 'componentize-qjs';
  let previous = '';
  let current = startDirectory;
  while (current !== previous) {
    const bin = join(current, 'node_modules', '@di-framework', scopedDirectory, 'bin', binName);
    if (existsSync(bin)) return bin;
    previous = current;
    current = dirname(current);
  }
  try {
    const require = createRequire(join(startDirectory, 'package.json'));
    const loaded = require(COMPONENTIZE_QJS_PACKAGE) as {
      nativeCliPath?: (os?: string, cpu?: string) => string | undefined;
    };
    const fromPackage = loaded.nativeCliPath?.(platform, arch);
    return fromPackage !== undefined && existsSync(fromPackage) ? fromPackage : undefined;
  } catch {
    return undefined;
  }
}

export function resolveComponentizeQjsPath(
  env: Record<string, string | undefined> = process.env,
  installedCliPath?: string,
  pathCli?: string,
): string | undefined {
  const explicit = env[COMPONENTIZE_QJS_ENV]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  return installedCliPath ?? pathCli;
}

/**
 * jco's entry inside a real node_modules tree, walking up from this package.
 * Bun's `import.meta.resolve` can return its global install cache, where jco's
 * own dependencies are not resolvable by Node; a node_modules path always is.
 */
export function findJcoEntry(startDirectory: string): string | undefined {
  let previous = '';
  let current = startDirectory;
  while (current !== previous) {
    const candidates = [
      join(current, 'node_modules', '@bytecodealliance', 'jco', 'dist', 'jco.js'),
      join(current, 'node_modules', '@bytecodealliance', 'jco', 'src', 'jco.js'),
    ];
    const candidate = candidates.find((path) => existsSync(path));
    if (candidate !== undefined) return candidate;
    previous = current;
    current = dirname(current);
  }
  return undefined;
}

export const DEFAULT_DEPS: WasmcloudDeps = {
  runner: async (command, args, options) => {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    return { exitCode: await child.exited };
  },
  capture: (command, args) => {
    // Bounded so a wedged tool (e.g. docker with an unreachable daemon) reads as unavailable.
    const result = spawnSync(command, args as string[], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status !== 0) return undefined;
    return (result.stdout || result.stderr).trim().split('\n')[0];
  },
  runCaptured: async (command, args, options) => {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { exitCode: await child.exited, stdout, stderr };
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  bundler: async ({ adapterPath, entryPath, outFile, guestsPath }) => {
    const bundle = await rolldown({
      input: adapterPath,
      external: COMPONENT_IMPORT_EXTERNAL,
      plugins: [nodeCompatibilityPlugin(entryPath, guestsPath)],
      transform: {
        decorator: { legacy: true },
      },
      treeshake: {
        moduleSideEffects(id) {
          return (
            id.includes('virtual:di-framework-wasmcloud-guests') ||
            id.endsWith('/guests.js') ||
            id.endsWith('\\guests.js')
          );
        },
      },
    });
    try {
      await bundle.write({ file: outFile, format: 'esm' });
    } finally {
      await bundle.close();
    }
  },
  jcoCliPath: () =>
    findJcoEntry(packageRoot) ??
    join(dirname(fileURLToPath(import.meta.resolve('@bytecodealliance/jco'))), 'jco.js'),
  componentizeQjsPath: () =>
    resolveComponentizeQjsPath(
      process.env,
      findInstalledComponentizeQjsCli(),
      Bun.which('componentize-qjs') ?? undefined,
    ),
  nodeBinaryPath: () => Bun.which('node') ?? undefined,
  wasmtimeBinaryPath: () => Bun.which('wasmtime') ?? undefined,
  washBinaryPath: () => Bun.which('wash') ?? undefined,
  // Assets ship transpiled under dist/assets; src and dist are siblings of it.
  assetsDirectory: () => join(packageRoot, 'dist', 'assets'),
  resolveFromProject: (projectRoot, specifier) => {
    try {
      return createRequire(join(projectRoot, 'package.json')).resolve(specifier);
    } catch {
      return undefined;
    }
  },
  env: process.env,
  cwd: () => process.cwd(),
};
