import type { ConfigSource } from '../types.ts';
import { type FileSourceOptions, objectFileSource } from './file-source.ts';

export type JsonFileSourceOptions = FileSourceOptions;

/**
 * Load a JSON file as a config object.
 */
export function jsonFileSource(path: string, options: JsonFileSourceOptions = {}): ConfigSource {
  return objectFileSource('json', path, options, (text) => JSON.parse(text) as unknown);
}
