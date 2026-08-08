/** Minimal Runtime Schema interface supporting validation and JSON schema retrieval */
export interface RuntimeSchema<T = any> {
  parse(input: unknown): T;
  readonly jsonSchema: Record<string, unknown>;
}

export interface CodegenConfig {
  /** Glob patterns or file paths to schema manifest files */
  manifests: string | string[];
  /** Directory where generated application surfaces will be written */
  outDir?: string;
  /** Directory where companion handler files reside (used by --init) */
  companionsDir?: string;
  /** Directory where policy companion files reside (used by --init) */
  policiesDir?: string;
  /** Optional custom ledger file path (defaults to outDir/.codegen-ledger.json) */
  ledgerPath?: string;
}

export interface SchemaCodegenManifestHandler {
  /** Module path (relative to manifest file location) */
  module: string;
  /** Exported class name */
  export: string;
  /** Method name on the handler class */
  method: string;
}

export interface SchemaCodegenManifestHttp {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | string;
  path: string;
  successStatus?: number;
  summary?: string;
  description?: string;
}

export interface SchemaCodegenManifestEvents {
  inbound?: {
    topic: string;
    event: string;
  };
  outbound?: {
    topic: string;
    event: string;
  };
}

export interface SchemaCodegenManifestRpcField {
  number: number;
  type: string;
}

export interface SchemaCodegenManifestRpc {
  package: string;
  service?: string;
  method?: string;
  inputFields?: Record<string, SchemaCodegenManifestRpcField | number>;
  outputFields?: Record<string, SchemaCodegenManifestRpcField | number>;
}

export interface SchemaCodegenManifestAuth {
  resource: string;
  action: string;
  policyModule?: string;
}

export interface SchemaCodegenManifestTool {
  name: string;
  description: string;
}

export interface SchemaCodegenOperation {
  input: string;
  output: string;
  handler: SchemaCodegenManifestHandler;
  http?: SchemaCodegenManifestHttp;
  events?: SchemaCodegenManifestEvents;
  rpc?: SchemaCodegenManifestRpc;
  authorization?: SchemaCodegenManifestAuth;
  tool?: SchemaCodegenManifestTool;
}

export interface SchemaCodegenManifestHttpGroup {
  prefix?: string;
  managedByDi?: boolean;
}

export type SchemaMap = Record<string, RuntimeSchema | { schema: RuntimeSchema; module?: string }>;

export interface SchemaCodegenManifest {
  name: string;
  version: string;
  schemas: SchemaMap;
  http?: SchemaCodegenManifestHttpGroup;
  operations: Record<string, SchemaCodegenOperation>;
}

export interface LoadedManifest {
  manifest: SchemaCodegenManifest;
  filePath: string;
}

export interface NormalizedSchema {
  name: string;
  runtimeSchema: RuntimeSchema;
  modulePath: string; // Absolute path to schema module
  relativeModulePathFromGen: string; // Import specifier relative to generated output dir
}

export interface NormalizedOperation {
  name: string;
  inputSchemaName: string;
  outputSchemaName: string;
  handler: {
    modulePath: string;
    relativeModulePathFromGen: string;
    exportName: string;
    methodName: string;
  };
  http?: {
    method: string;
    path: string;
    successStatus: number;
    summary?: string;
    description?: string;
  };
  events?: {
    inbound?: {
      topic: string;
      event: string;
    };
    outbound?: {
      topic: string;
      event: string;
    };
  };
  rpc?: {
    package: string;
    service: string;
    method: string;
    inputFields: Record<string, SchemaCodegenManifestRpcField>;
    outputFields: Record<string, SchemaCodegenManifestRpcField>;
  };
  authorization?: {
    resource: string;
    action: string;
    policyModulePath?: string;
    relativePolicyModulePathFromGen?: string;
  };
  tool?: {
    name: string;
    description: string;
  };
}

export interface NormalizedManifest {
  name: string;
  version: string;
  manifestFilePath: string;
  outputDir: string;
  httpPrefix?: string;
  managedByDi: boolean;
  schemas: Record<string, NormalizedSchema>;
  operations: Record<string, NormalizedOperation>;
}

export interface OwnershipLedger {
  version: string;
  generatedFiles: string[];
}

export interface GenerateOptions {
  /** Config object or path to config file */
  config?: CodegenConfig | string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Whether to initialize missing companion handler/policy skeletons */
  init?: boolean;
  /** Check mode: do not write files, return drift status */
  check?: boolean;
  /** Clean mode: delete safe stale files */
  clean?: boolean;
  /** Explicit list of manifest objects (if calling programmatically without loading files) */
  manifests?: SchemaCodegenManifest[];
  /** Override outDir */
  outDir?: string;
}

export interface GeneratedFileResult {
  path: string; // Absolute path
  relativePath: string; // Relative to cwd
  content: string;
  status: 'created' | 'updated' | 'unchanged' | 'deleted' | 'drifted';
}

export interface GenerateResult {
  success: boolean;
  drifted: boolean;
  files: GeneratedFileResult[];
  ledgerPath: string;
  diagnostics: string[];
}
