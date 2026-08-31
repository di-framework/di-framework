import { requireOptionalPeer } from '../optional-peer.ts';
import type { ConfigSource } from '../types.ts';
import { type FileSourceOptions, objectFileSource } from './file-source.ts';

export interface TomlFileSourceOptions extends FileSourceOptions {
  /** Injected parser for tests or a custom TOML engine. */
  parse?: (text: string) => unknown;
}

interface TomlModule {
  parse(text: string): unknown;
}

function defaultTomlParse(text: string): unknown {
  return requireOptionalPeer<TomlModule>(
    'smol-toml',
    '@di-framework/config/toml requires the optional peer dependency "smol-toml". Install it with: bun add smol-toml',
  ).parse(text);
}

/**
 * Load a TOML file as a config object.
 *
 * Requires the optional peer `smol-toml`.
 */
export function tomlFileSource(path: string, options: TomlFileSourceOptions = {}): ConfigSource {
  return objectFileSource('toml', path, options, options.parse ?? defaultTomlParse);
}
