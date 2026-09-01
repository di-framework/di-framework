import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { SCHEMAS } from './decorators.ts';
import registry from './registry.ts';

export type OpenAPIOptions = {
  title?: string;
  version?: string;
  description?: string;
  outputPath?: string;
  schemas?: Record<string, unknown>;
  /** `components.securitySchemes`, passed through verbatim. */
  securitySchemes?: Record<string, unknown>;
  /** Document-level default `security` requirement. */
  security?: Array<Record<string, string[]>>;
};

export interface OpenAPIInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

export interface OpenAPIParameter extends Record<string, unknown> {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: unknown;
}

export interface OpenAPIResponse extends Record<string, unknown> {
  readonly description?: string;
}

export interface OpenAPIOperation extends Record<string, unknown> {
  readonly summary?: string;
  readonly description?: string;
  readonly operationId?: string;
  readonly requestBody?: unknown;
  readonly responses: Record<string, OpenAPIResponse>;
  parameters?: OpenAPIParameter[];
  readonly security?: Array<Record<string, string[]>>;
}

export interface OpenAPIDocument {
  readonly openapi: '3.1.0';
  readonly info: OpenAPIInfo;
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  readonly security?: Array<Record<string, string[]>>;
}

export interface OpenAPIRegistry {
  getTargets(): Iterable<unknown>;
}

interface OpenAPIEndpointDeclaration {
  readonly isEndpoint?: boolean;
  readonly path?: string;
  readonly method?: string;
  readonly metadata?: {
    readonly summary?: string;
    readonly description?: string;
    readonly requestBody?: unknown;
    readonly responses?: Record<string, unknown>;
    readonly parameters?: unknown[];
    readonly security?: unknown;
  };
}

export interface GenerateOpenAPIDocumentOptions {
  /** Modules imported to register their decorated controllers. */
  readonly controllerModules: readonly string[];
  /** OpenAPI metadata and schema configuration. */
  readonly configuration?: OpenAPIOptions;
  /** Base directory for relative controller module paths. */
  readonly cwd?: string;
  /** Registry populated by the controller modules. */
  readonly registry?: OpenAPIRegistry;
  /** Injectable module loader for embedders and tests. */
  readonly importModule?: (absolutePath: string) => Promise<unknown>;
}

export interface OpenAPIGenerationResult {
  readonly document: OpenAPIDocument;
  readonly controllerModules: readonly string[];
}

export interface OpenAPIWriteResult {
  readonly outputPath: string;
  readonly bytes: number;
}

export type OpenAPIOperationErrorCode =
  | 'controllers-required'
  | 'controller-load-failed'
  | 'document-write-failed';

export class OpenAPIOperationError extends Error {
  readonly code: OpenAPIOperationErrorCode;
  readonly path?: string;

  constructor(
    code: OpenAPIOperationErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'OpenAPIOperationError';
    this.code = code;
    this.path = options.path;
  }
}

/**
 * Load explicit controller modules and generate an OpenAPI document.
 *
 * This operation has no CLI concerns: paths, registry, module loading, and
 * document configuration are supplied explicitly and the typed document is
 * returned to the caller.
 */
export async function generateOpenAPIDocument(
  options: GenerateOpenAPIDocumentOptions,
): Promise<OpenAPIGenerationResult> {
  if (options.controllerModules.length === 0) {
    throw new OpenAPIOperationError(
      'controllers-required',
      'At least one controller module is required',
    );
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const controllerModules = options.controllerModules.map((modulePath) =>
    isAbsolute(modulePath) ? resolve(modulePath) : resolve(cwd, modulePath),
  );
  const importModule = options.importModule ?? ((modulePath: string) => import(modulePath));

  for (const modulePath of controllerModules) {
    try {
      await importModule(modulePath);
    } catch (cause) {
      throw new OpenAPIOperationError(
        'controller-load-failed',
        `Unable to load controller module: ${modulePath}`,
        { path: modulePath, cause },
      );
    }
  }

  return {
    document: generateOpenAPI(options.configuration, options.registry ?? registry),
    controllerModules,
  };
}

/** Write a generated document as formatted JSON. Writing is always explicit. */
export function writeOpenAPIDocument(
  document: OpenAPIDocument,
  outputPath: string,
  cwd = process.cwd(),
): OpenAPIWriteResult {
  const absolutePath = isAbsolute(outputPath) ? resolve(outputPath) : resolve(cwd, outputPath);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  try {
    writeFileSync(absolutePath, contents, 'utf8');
  } catch (cause) {
    throw new OpenAPIOperationError(
      'document-write-failed',
      `Unable to write OpenAPI document: ${absolutePath}`,
      { path: absolutePath, cause },
    );
  }
  return { outputPath: absolutePath, bytes: Buffer.byteLength(contents, 'utf8') };
}

const COLLECT_REFS_MAX_DEPTH = 64;

/** Recursively extract `$ref` schema names from a value (depth-bounded). */
function collectRefs(
  obj: unknown,
  out: Set<string>,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (depth > COLLECT_REFS_MAX_DEPTH) return;
  if (typeof obj !== 'object' || obj === null) return;
  if (seen.has(obj as object)) return;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    for (const item of obj) collectRefs(item, out, depth + 1, seen);
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value);
      if (match?.[1]) out.add(match[1]);
    } else {
      collectRefs(value, out, depth + 1, seen);
    }
  }
}

/**
 * Resolve a schema name and all schemas it transitively references.
 * Writes resolved schemas into `resolved`.
 */
function resolveSchema(
  name: string,
  resolved: Record<string, unknown>,
  schemas: Record<string, unknown>,
): void {
  if (name in resolved) return;

  const schema = schemas[name];
  if (!schema) return;

  resolved[name] = schema;

  // Find transitive refs within the schema itself
  const transitive = new Set<string>();
  collectRefs(schema, transitive);
  for (const dep of transitive) {
    resolveSchema(dep, resolved, schemas);
  }
}

/** Convert itty-router `:param` paths to OpenAPI `{param}` format. */
function toOpenAPIPath(path: string): string {
  return path.replace(/:([a-zA-Z_]\w*)/g, '{$1}');
}

/** Extract path parameter names from an itty-router path. */
function extractPathParams(path: string): string[] {
  const names: string[] = [];
  const re = /:([a-zA-Z_]\w*)/g;
  let m = re.exec(path);
  while (m !== null) {
    if (m[1]) names.push(m[1]);
    m = re.exec(path);
  }
  return names;
}

export function generateOpenAPI(
  options: OpenAPIOptions = {},
  registryToUse: OpenAPIRegistry = registry,
): OpenAPIDocument {
  const spec: OpenAPIDocument = {
    openapi: '3.1.0',
    info: {
      title: options.title || 'Generated API',
      version: options.version || '1.0.0',
      description: options.description || 'API documentation generated by @di-framework/http.',
    },
    paths: {},
    components: {
      schemas: {},
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    },
    ...(options.security ? { security: options.security } : {}),
  };

  const targets = registryToUse.getTargets();

  const metaParamsMap = new Map<string, OpenAPIParameter[]>();

  for (const target of targets) {
    const controller = target as Record<string | symbol, unknown> & { name?: unknown };
    const controllerName =
      typeof controller.name === 'string' ? controller.name : 'AnonymousController';
    // Look for endpoints on the target (static properties)
    for (const key of Object.getOwnPropertyNames(controller)) {
      const property = controller[key] as OpenAPIEndpointDeclaration | undefined;
      if (property?.isEndpoint) {
        const path = property.path || '/unknown';
        const method = (property.method || 'get').toLowerCase();

        if (property.metadata?.parameters) {
          metaParamsMap.set(
            `${path}|${method}`,
            property.metadata.parameters as OpenAPIParameter[],
          );
        }

        if (!spec.paths[path]) {
          spec.paths[path] = {};
        }

        spec.paths[path][method] = {
          summary: property.metadata?.summary || key,
          description: property.metadata?.description,
          operationId: `${controllerName}.${key}`,
          requestBody: property.metadata?.requestBody,
          responses: (property.metadata?.responses as Record<string, OpenAPIResponse>) || {
            '200': {
              description: 'OK',
            },
          },
          // Tested against `undefined`, not truthiness: an empty array is
          // meaningful in OpenAPI — it opts an operation out of the
          // document-level `security` default.
          ...(property.metadata?.security !== undefined
            ? { security: property.metadata.security as Array<Record<string, string[]>> }
            : {}),
        };
      }
    }
  }

  // Rewrite paths: convert :param → {param} and inject parameters
  const rewrittenPaths: Record<string, Record<string, OpenAPIOperation>> = {};

  for (const [rawPath, methods] of Object.entries(spec.paths)) {
    const openApiPath = toOpenAPIPath(rawPath);
    const pathParamNames = extractPathParams(rawPath);

    const autoParams = pathParamNames.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    rewrittenPaths[openApiPath] ??= {};

    for (const [method, operation] of Object.entries(methods)) {
      const decoratorParams = metaParamsMap.get(`${rawPath}|${method}`) ?? [];
      if (autoParams.length > 0 || decoratorParams.length > 0) {
        operation.parameters = [...autoParams, ...decoratorParams];
      }
      rewrittenPaths[openApiPath][method] = operation;
    }
  }

  spec.paths = rewrittenPaths;

  // Collect schemas from decorator Symbols
  const resolved: Record<string, unknown> = {};

  for (const target of targets) {
    const refs: Set<string> | undefined = (target as Record<symbol, Set<string>>)[SCHEMAS];
    if (!refs) continue;

    for (const name of refs) {
      resolveSchema(name, resolved, options.schemas || {});
    }
  }

  spec.components.schemas = resolved;

  return spec;
}
