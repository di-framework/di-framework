import { readFileSync } from 'node:fs';
import { deepMerge } from '../path.ts';
import { getSelectedProfiles, profileConfigPath } from '../profiles.ts';
import type { ConfigSource } from '../types.ts';

export interface FileSourceOptions {
  /** When true, missing files yield `{}` instead of throwing. Default `false`. */
  optional?: boolean;
  /**
   * Profile overlays to merge after the base file (`{profile}.config.{ext}`).
   * Defaults to {@link getSelectedProfiles} (`@WithProfile` / `loadConfig({ profiles })`).
   */
  profiles?: readonly string[];
}

export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function parseObject(
  format: string,
  path: string,
  text: string,
  parse: (text: string) => unknown,
): Record<string, unknown> {
  const parsed: unknown = parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${format.toUpperCase()} config at ${path} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function readObjectFile(
  format: string,
  path: string,
  parse: (text: string) => unknown,
  optional: boolean,
): Record<string, unknown> {
  try {
    return parseObject(format, path, readFileSync(path, 'utf8'), parse);
  } catch (err) {
    if (optional && isNotFound(err)) return {};
    throw err;
  }
}

export function objectFileSource(
  format: string,
  path: string,
  options: FileSourceOptions,
  parse: (text: string) => unknown,
): ConfigSource {
  return {
    name: `${format}:${path}`,
    load() {
      const profiles = options.profiles ?? getSelectedProfiles();
      for (const profile of profiles) profileConfigPath(path, profile);
      let merged = readObjectFile(format, path, parse, options.optional === true);
      for (const profile of profiles) {
        const overlay = profileConfigPath(path, profile);
        merged = deepMerge(merged, readObjectFile(format, overlay, parse, true));
      }
      return merged;
    },
  };
}
