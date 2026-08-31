export {
  type LoadAndRegisterOptions,
  loadAndRegisterConfig,
  loadAndRegisterConfigSync,
} from './src/bootstrap.ts';
export { coerceEnvValue, toCamelCase, transformKeySegment } from './src/coerce.ts';
export { Configuration, Value, WithProfile } from './src/decorators.ts';
export { loadConfig, loadConfigSync } from './src/load.ts';
export { deepMerge, flattenEntries, getByPath, setByPath } from './src/path.ts';
export {
  getSelectedProfiles,
  profileConfigPath,
  setSelectedProfiles,
} from './src/profiles.ts';
export { registerConfig } from './src/register.ts';
export { identitySchema, schemaFromParse } from './src/schema.ts';
export { type EnvSourceOptions, envSource } from './src/sources/env.ts';
export { type JsonFileSourceOptions, jsonFileSource } from './src/sources/json-file.ts';
export { objectSource } from './src/sources/object.ts';
export { type TomlFileSourceOptions, tomlFileSource } from './src/sources/toml-file.ts';
export { type YamlFileSourceOptions, yamlFileSource } from './src/sources/yaml-file.ts';

export type {
  ConfigContainer,
  ConfigKeyCase,
  ConfigSchema,
  ConfigSource,
  ConfigurationDecoratorOptions,
  LoadConfigOptions,
  RegisterConfigOptions,
  ValueDecoratorOptions,
} from './src/types.ts';
