import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GenerateOpenAPIDocumentOptions,
  OpenAPIDocument,
} from '../../di-framework-http/src/openapi.ts';
import { OpenAPIOperationError } from '../../di-framework-http/src/openapi.ts';
import {
  type HttpOpenAPIOperations,
  parseHttpOpenAPIGenerateArgs,
  runHttpOpenAPIGenerate,
} from '../cmd/http/openapi-generate';
import { type CliIo, type CommandNode, executeCommand } from '../command';

const DOCUMENT: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Test API', version: '1.0.0', description: '' },
  paths: {},
  components: { schemas: {} },
};

function captureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

function commandTree(operations?: HttpOpenAPIOperations, cwd = '/workspace'): CommandNode {
  return {
    description: 'root',
    children: {
      http: {
        description: 'http',
        children: {
          openapi: {
            description: 'openapi',
            children: {
              generate: {
                description: 'generate',
                run: ({ args }) => runHttpOpenAPIGenerate(args, operations, cwd),
              },
            },
          },
        },
      },
    },
  };
}

function operations(
  generate: HttpOpenAPIOperations['generateOpenAPIDocument'],
  write: HttpOpenAPIOperations['writeOpenAPIDocument'] = () => ({
    outputPath: '/workspace/openapi.json',
    bytes: 128,
  }),
): HttpOpenAPIOperations {
  return {
    generateOpenAPIDocument: generate,
    writeOpenAPIDocument: write,
    OpenAPIOperationError,
  };
}

describe('http openapi generate command', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('maps repeatable controller and output arguments to the typed HTTP operations', async () => {
    const generationCalls: GenerateOpenAPIDocumentOptions[] = [];
    const writeCalls: unknown[][] = [];
    const api = operations(
      async (options) => {
        generationCalls.push(options);
        return {
          document: DOCUMENT,
          controllerModules: ['/workspace/src/api.ts', '/workspace/src/admin.ts'],
        };
      },
      (document, outputPath, cwd) => {
        writeCalls.push([document, outputPath, cwd]);
        return { outputPath: '/workspace/spec/openapi.json', bytes: 256 };
      },
    );

    const result = await runHttpOpenAPIGenerate(
      [
        '--controllers',
        './src/api.ts',
        '--controllers',
        './src/admin.ts',
        '--output',
        './spec/openapi.json',
      ],
      api,
      '/workspace',
    );

    expect(generationCalls).toEqual([
      {
        controllerModules: ['./src/api.ts', './src/admin.ts'],
        cwd: '/workspace',
      },
    ]);
    expect(writeCalls).toEqual([[DOCUMENT, './spec/openapi.json', '/workspace']]);
    expect(result.data).toEqual({
      controllerModules: ['/workspace/src/api.ts', '/workspace/src/admin.ts'],
      outputPath: '/workspace/spec/openapi.json',
      bytes: 256,
    });
    expect(result.text).toBe(
      'Generated OpenAPI document at /workspace/spec/openapi.json (256 bytes from 2 controller module(s))',
    );
  });

  it('renders the same typed result through text and unified JSON output', async () => {
    const api = operations(async () => ({
      document: DOCUMENT,
      controllerModules: ['/workspace/controllers.ts'],
    }));
    const tree = commandTree(api);

    const text = captureIo();
    expect(
      await executeCommand(
        tree,
        ['http', 'openapi', 'generate', '--controllers', './controllers.ts'],
        text.io,
      ),
    ).toBe(0);
    expect(text.stdout.join('')).toBe(
      'Generated OpenAPI document at /workspace/openapi.json (128 bytes from 1 controller module(s))\n',
    );
    expect(text.stderr).toEqual([]);

    const json = captureIo();
    expect(
      await executeCommand(
        tree,
        ['--json', 'http', 'openapi', 'generate', '--controllers', './controllers.ts'],
        json.io,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout.join(''))).toEqual({
      schemaVersion: 1,
      command: 'http openapi generate',
      ok: true,
      data: {
        controllerModules: ['/workspace/controllers.ts'],
        outputPath: '/workspace/openapi.json',
        bytes: 128,
      },
    });
    expect(json.stderr).toEqual([]);
  });

  it('rejects missing values, duplicate output, unknown arguments, and missing controllers', () => {
    expect(() => parseHttpOpenAPIGenerateArgs(['--controllers'])).toThrow('Missing value');
    expect(() => parseHttpOpenAPIGenerateArgs(['--controllers', '--output', 'x'])).toThrow(
      'Missing value',
    );
    expect(() =>
      parseHttpOpenAPIGenerateArgs([
        '--controllers',
        'api.ts',
        '--output',
        'one.json',
        '--output',
        'two.json',
      ]),
    ).toThrow('only once');
    expect(() => parseHttpOpenAPIGenerateArgs(['--controllers', 'api.ts', 'extra'])).toThrow(
      'Unknown option or argument',
    );
    expect(() => parseHttpOpenAPIGenerateArgs([])).toThrow(
      'At least one --controllers module is required',
    );
  });

  it('maps usage and typed package failures to stable codes and exit statuses', async () => {
    const api = operations(async () => {
      throw new OpenAPIOperationError(
        'controller-load-failed',
        'Unable to load controller module: /workspace/broken.ts',
        { path: '/workspace/broken.ts' },
      );
    });
    const tree = commandTree(api);

    const usage = captureIo();
    expect(await executeCommand(tree, ['http', 'openapi', 'generate', '--json'], usage.io)).toBe(2);
    expect(JSON.parse(usage.stdout.join('')).error.code).toBe('HTTP_CONTROLLERS_REQUIRED');

    const failure = captureIo();
    expect(
      await executeCommand(
        tree,
        ['http', 'openapi', 'generate', '--controllers', 'broken.ts', '--json'],
        failure.io,
      ),
    ).toBe(3);
    expect(JSON.parse(failure.stdout.join('')).error).toEqual({
      code: 'HTTP_CONTROLLER_LOAD_FAILED',
      message: 'Unable to load controller module: /workspace/broken.ts',
      details: {
        operationCode: 'controller-load-failed',
        path: '/workspace/broken.ts',
      },
    });
  });

  it('maps document write failures without recreating write behavior', async () => {
    const api = operations(
      async () => ({ document: DOCUMENT, controllerModules: ['/workspace/api.ts'] }),
      () => {
        throw new OpenAPIOperationError(
          'document-write-failed',
          'Unable to write OpenAPI document: /workspace/blocked/openapi.json',
          { path: '/workspace/blocked/openapi.json' },
        );
      },
    );
    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree(api),
        ['http', 'openapi', 'generate', '--controllers', 'api.ts', '--json'],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stdout.join('')).error.code).toBe('HTTP_DOCUMENT_WRITE_FAILED');
  });

  it('loads the HTTP package from the current project without a CLI dependency', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'di-framework-cli-http-project-'));
    temps.push(cwd);
    const packageDirectory = join(cwd, 'node_modules', '@di-framework', 'http');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
    writeFileSync(
      join(packageDirectory, 'package.json'),
      '{"name":"@di-framework/http","type":"module","exports":"./index.js"}\n',
    );
    writeFileSync(
      join(packageDirectory, 'index.js'),
      `export class OpenAPIOperationError extends Error {}
export async function generateOpenAPIDocument(options) {
  return {
    document: { openapi: '3.1.0', info: {}, paths: {}, components: { schemas: {} } },
    controllerModules: options.controllerModules,
  };
}
export function writeOpenAPIDocument(_document, outputPath) {
  return { outputPath, bytes: 42 };
}
`,
    );

    const result = await runHttpOpenAPIGenerate(
      ['--controllers', './controllers.ts', '--output', './openapi.json'],
      undefined,
      cwd,
    );
    expect(result.data).toEqual({
      controllerModules: ['./controllers.ts'],
      outputPath: './openapi.json',
      bytes: 42,
    });
  });

  it('reports an unavailable project HTTP package as a stable execution failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'di-framework-cli-no-http-'));
    temps.push(cwd);
    writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree(undefined, cwd),
        ['http', 'openapi', 'generate', '--controllers', './controllers.ts', '--json'],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stdout.join('')).error).toMatchObject({
      code: 'HTTP_PACKAGE_UNAVAILABLE',
      message: 'Unable to load @di-framework/http from the current project',
    });
  });
});
