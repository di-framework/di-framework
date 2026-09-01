import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  generateOpenAPIDocument,
  OpenAPIOperationError,
  writeOpenAPIDocument,
} from '@di-framework/http';
import { CommandFailure, type CommandResult } from '../../command';

export type HttpOpenAPIOperations = {
  readonly generateOpenAPIDocument: typeof generateOpenAPIDocument;
  readonly writeOpenAPIDocument: typeof writeOpenAPIDocument;
  readonly OpenAPIOperationError: typeof OpenAPIOperationError;
};

export interface HttpOpenAPIGenerateCliOptions {
  readonly controllerModules: readonly string[];
  readonly outputPath: string;
}

export interface HttpOpenAPIGenerateCommandResult {
  readonly controllerModules: readonly string[];
  readonly outputPath: string;
  readonly bytes: number;
}

export function parseHttpOpenAPIGenerateArgs(
  args: readonly string[],
): HttpOpenAPIGenerateCliOptions {
  const controllerModules: string[] = [];
  let outputPath = 'openapi.json';
  let outputConfigured = false;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    if (token === '--controllers') {
      controllerModules.push(readOptionValue(args, ++position, token));
      continue;
    }
    if (token === '--output') {
      if (outputConfigured) invalidUsage('Option may be provided only once: --output', token);
      outputPath = readOptionValue(args, ++position, token);
      outputConfigured = true;
      continue;
    }
    invalidUsage(`Unknown option or argument: ${token}`, token);
  }

  if (controllerModules.length === 0) {
    throw new CommandFailure(
      'HTTP_CONTROLLERS_REQUIRED',
      'At least one --controllers module is required',
      2,
    );
  }
  return { controllerModules, outputPath };
}

export async function runHttpOpenAPIGenerate(
  args: readonly string[],
  operations?: HttpOpenAPIOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseHttpOpenAPIGenerateArgs(args);
  const api = operations ?? (await loadHttpOpenAPIOperations(cwd));
  try {
    const generated = await api.generateOpenAPIDocument({
      controllerModules: options.controllerModules,
      cwd,
    });
    const written = api.writeOpenAPIDocument(generated.document, options.outputPath, cwd);
    const result: HttpOpenAPIGenerateCommandResult = {
      controllerModules: generated.controllerModules,
      outputPath: written.outputPath,
      bytes: written.bytes,
    };
    return {
      data: {
        controllerModules: [...result.controllerModules],
        outputPath: result.outputPath,
        bytes: result.bytes,
      },
      text: `Generated OpenAPI document at ${result.outputPath} (${result.bytes} bytes from ${result.controllerModules.length} controller module(s))`,
    };
  } catch (error) {
    if (!(error instanceof api.OpenAPIOperationError)) throw error;
    throw operationFailure(error);
  }
}

async function loadHttpOpenAPIOperations(cwd: string): Promise<HttpOpenAPIOperations> {
  try {
    const projectRequire = createRequire(`${resolve(cwd, 'package.json')}`);
    const modulePath = projectRequire.resolve('@di-framework/http');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'HTTP_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/http from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function readOptionValue(args: readonly string[], position: number, option: string): string {
  const value = args[position];
  if (value == null || value.startsWith('--')) {
    invalidUsage(`Missing value for ${option}`, option);
  }
  return value;
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}

function operationFailure(error: OpenAPIOperationError): CommandFailure {
  const code = `HTTP_${error.code.replaceAll('-', '_').toUpperCase()}`;
  return new CommandFailure(code, error.message, error.code === 'controllers-required' ? 2 : 3, {
    operationCode: error.code,
    path: error.path,
  });
}
