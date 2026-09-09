import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  type GenerateOpenAPIDocumentOptions,
  generateOpenAPI,
  type OpenAPIDocument,
  type OpenAPIGenerationResult,
  OpenAPIOperationError,
  type OpenAPIWriteResult,
} from './openapi-runtime.ts';
import registry from './registry.ts';

export * from './openapi-runtime.ts';

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
