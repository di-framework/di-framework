export {
  defineExtension,
  EXTENSION_NAME_PATTERN,
  EXTENSION_SCHEMA_VERSION,
  type ExtensionManifest,
  type ManifestIssue,
  validateExtensionManifest,
} from './manifest.js';
export {
  type CliIo,
  type CliStream,
  type CommandContext,
  CommandFailure,
  type CommandNode,
  type CommandResult,
  type ExitCode,
  isCommandFailure,
  type JsonValue,
} from './types.js';
