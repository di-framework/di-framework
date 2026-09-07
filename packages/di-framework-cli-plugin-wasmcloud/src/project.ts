import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';

export const CONFIG_FILE_NAME = 'di-framework.config.json';

export type WasmcloudProject = {
  /** Display name exactly as configured. */
  applicationName: string;
  configPath: string;
  entryPath: string;
  outputPath: string;
  /** Absolute path to the bindings file when present or configured. */
  bindingsPath: string | undefined;
  /** True when `bindings` was set in di-framework.config.json. */
  bindingsConfigured: boolean;
  bindingsRelative: string;
  projectRoot: string;
  version: string;
  /** `name` slugified into a WIT package identifier. */
  witName: string;
};

export function findUp(startDirectory: string, fileName: string): string | undefined {
  let previous = '';
  let current = resolve(startDirectory);
  while (current !== previous) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) return candidate;
    previous = current;
    current = dirname(current);
  }
  return undefined;
}

function configInvalid(message: string, configPath: string): never {
  throw new CommandFailure('WASMCLOUD_CONFIG_INVALID', message, 2, { configPath });
}

/** Paths from the config must stay inside the project root. */
export function resolveInside(
  projectRoot: string,
  value: string,
  label: string,
  configPath: string,
): string {
  const absolutePath = resolve(projectRoot, value);
  const relativePath = relative(projectRoot, absolutePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    configInvalid(`${label} must point to a file inside the project`, configPath);
  }
  return absolutePath;
}

export function asWitIdentifier(value: string): string {
  const collapsed = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start++;
  while (end > start && collapsed[end - 1] === '-') end--;
  const identifier = collapsed.slice(start, end);
  return /^[a-z]/.test(identifier) ? identifier : `app-${identifier || 'component'}`;
}

export function loadProject(startDirectory: string): WasmcloudProject {
  const configPath = findUp(startDirectory, CONFIG_FILE_NAME);
  if (configPath === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_PROJECT_NOT_FOUND',
      `No ${CONFIG_FILE_NAME} found. Run this command from a DI Framework component project.`,
      2,
      { startDirectory },
    );
  }

  const projectRoot = dirname(configPath);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    configInvalid(
      `Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      configPath,
    );
  }

  if (typeof config.name !== 'string' || config.name.trim() === '') {
    configInvalid(`${CONFIG_FILE_NAME} must contain a non-empty "name"`, configPath);
  }
  if (typeof config.entry !== 'string' || config.entry.trim() === '') {
    configInvalid(`${CONFIG_FILE_NAME} must contain a non-empty "entry"`, configPath);
  }
  if (config.output !== undefined && typeof config.output !== 'string') {
    configInvalid(`${CONFIG_FILE_NAME} "output" must be a string when present`, configPath);
  }
  if (config.bindings !== undefined && typeof config.bindings !== 'string') {
    configInvalid(`${CONFIG_FILE_NAME} "bindings" must be a string when present`, configPath);
  }

  const witName = asWitIdentifier(config.name);
  const entryPath = resolveInside(projectRoot, config.entry, 'entry', configPath);
  const outputPath = resolveInside(
    projectRoot,
    config.output ?? `dist/${witName}.wasm`,
    'output',
    configPath,
  );
  const bindingsValue = typeof config.bindings === 'string' ? config.bindings.trim() : '';
  const bindingsConfigured = bindingsValue !== '';
  const bindingsRelative = bindingsConfigured ? bindingsValue : 'src/bindings.ts';
  const bindingsPath = resolveInside(projectRoot, bindingsRelative, 'bindings', configPath);

  try {
    accessSync(entryPath, constants.R_OK);
  } catch {
    configInvalid(`entry "${config.entry}" is not readable`, configPath);
  }

  const packagePath = join(projectRoot, 'package.json');
  const packageJson: Record<string, unknown> = existsSync(packagePath)
    ? (JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>)
    : {};
  const version =
    typeof packageJson.version === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)
      ? packageJson.version
      : '0.1.0';

  return {
    applicationName: config.name,
    configPath,
    entryPath,
    outputPath,
    bindingsPath,
    bindingsConfigured,
    bindingsRelative,
    projectRoot,
    version,
    witName,
  };
}
