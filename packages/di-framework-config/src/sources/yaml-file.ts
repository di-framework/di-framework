import { requireOptionalPeer } from '../optional-peer.ts';
import type { ConfigSource } from '../types.ts';
import { type FileSourceOptions, objectFileSource } from './file-source.ts';

export interface YamlFileSourceOptions extends FileSourceOptions {
  /** Injected parser for tests or a custom YAML engine. */
  parse?: (text: string) => unknown;
}

interface YamlModule {
  parse(text: string): unknown;
}

function defaultYamlParse(text: string): unknown {
  return requireOptionalPeer<YamlModule>(
    'yaml',
    '@di-framework/config/yaml requires the optional peer dependency "yaml". Install it with: bun add yaml',
  ).parse(text);
}

/**
 * Load a YAML file as a config object.
 *
 * Requires the optional peer `yaml`. Multi-document streams are not supported.
 */
export function yamlFileSource(path: string, options: YamlFileSourceOptions = {}): ConfigSource {
  return objectFileSource('yaml', path, options, options.parse ?? defaultYamlParse);
}
