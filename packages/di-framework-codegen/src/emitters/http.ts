import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest, NormalizedOperation } from '../types.ts';

export function emitHttpSurface(manifest: NormalizedManifest): string | null {
  const httpOps = Object.values(manifest.operations)
    .filter((op) => op.http)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (httpOps.length === 0 && !manifest.httpPrefix) {
    return null;
  }

  const controllerName = `${capitalize(manifest.name)}${capitalize(manifest.version)}HttpController`;
  const prefix = manifest.httpPrefix ?? '';

  const handlerImports = importLines(
    httpOps.map((op) => [op.handler.relativeModulePathFromGen, op.handler.exportName]),
  );
  const schemaImports = importLines(
    httpOps.flatMap((op) => {
      const names = schemaNamesInMetadata(op);
      return names.flatMap((name) => {
        const schema = manifest.schemas[name];
        return schema ? [[schema.relativeModulePathFromGen, name] as [string, string]] : [];
      });
    }),
  );

  const validators = new Set<string>();
  for (const op of httpOps) {
    validators.add(`validate${op.inputSchemaName}`);
    validators.add(`validate${op.outputSchemaName}`);
  }
  const validatorsList = Array.from(validators)
    .sort((left, right) => left.localeCompare(right))
    .join(',\n  ');

  const allHandlerExports = Array.from(new Set(httpOps.map((op) => op.handler.exportName))).sort(
    (left, right) => left.localeCompare(right),
  );
  const exportToPropMap = new Map<string, string>();
  const handlerProps: string[] = [];
  for (const exportName of allHandlerExports) {
    const propName = allHandlerExports.length === 1 ? 'handlers' : uncapitalize(exportName);
    exportToPropMap.set(exportName, propName);
    handlerProps.push(`  @Component(${exportName})\n  private ${propName}!: ${exportName};`);
  }

  const routes = httpOps.map((op) =>
    emitRoute(op, controllerName, prefix, exportToPropMap.get(op.handler.exportName)!),
  );

  const httpImports =
    httpOps.length > 0
      ? `import { useContainer } from '@di-framework/core/container';
import { Component } from '@di-framework/core/decorators';
import { Controller, Endpoint, json, TypedRouter } from '@di-framework/http';`
      : `import { Controller } from '@di-framework/http';`;

  const schemaBlock = schemaImports.length > 0 ? `\n${schemaImports.join('\n')}` : '';
  const validatorBlock =
    validatorsList.length > 0 ? `\nimport {\n  ${validatorsList},\n} from './contracts';` : '';
  const routesConst = httpOps.length > 0 ? `\nconst routes = TypedRouter();\n` : '';
  const routeFields = routes.length > 0 ? `\n\n${routes.join('\n\n')}` : '';

  return `${OWNERSHIP_HEADER}

${httpImports}
${handlerImports.join('\n')}${schemaBlock}${validatorBlock}
${routesConst}
@Controller()
export class ${controllerName} {
${handlerProps.join('\n\n')}${routeFields}
}

${httpOps.length > 0 ? 'export { routes };\n' : ''}`;
}

function emitRoute(
  op: NormalizedOperation,
  controllerName: string,
  prefix: string,
  propName: string,
): string {
  const http = op.http!;
  const method = http.method.toLowerCase();
  const path = joinPath(prefix, http.path);
  const status = http.successStatus;
  const statusArg = status !== 200 ? `, { status: ${status} }` : '';
  const bodyRead =
    method === 'get' || method === 'head'
      ? `const body = (request as { content?: unknown }).content ?? {};`
      : `const body = (request as { content?: unknown }).content;`;

  return `  @Endpoint({
${endpointMetadata(op)}
  })
  static ${op.name} = routes.${method}('${escapeString(path)}', async (request) => {
    const self = useContainer().resolve(${controllerName});
    ${bodyRead}
    const command = validate${op.inputSchemaName}(body);

    const output = await self.${propName}.${op.handler.methodName}(command, {
      transport: 'http' as const,
      request,
    });

    if (output instanceof Response) return output;
    return json(validate${op.outputSchemaName}(output)${statusArg});
  });`;
}

function schemaNamesInMetadata(op: NormalizedOperation): string[] {
  const http = op.http!;
  const method = http.method.toLowerCase();
  const names: string[] = [];
  if (method === 'post' || method === 'put' || method === 'patch') names.push(op.inputSchemaName);
  if (http.successStatus !== 204) names.push(op.outputSchemaName);
  return names;
}

function endpointMetadata(op: NormalizedOperation): string {
  const http = op.http!;
  const method = http.method.toLowerCase();
  const lines: string[] = [];
  if (http.summary) lines.push(`    summary: '${escapeString(http.summary)}',`);
  if (http.description) lines.push(`    description: '${escapeString(http.description)}',`);
  if (http.parameters && http.parameters.length > 0) {
    lines.push(`    parameters: ${JSON.stringify(http.parameters)},`);
  }
  if (method === 'post' || method === 'put' || method === 'patch') {
    lines.push(`    requestBody: {
      content: {
        'application/json': {
          schema: ${op.inputSchemaName}.jsonSchema,
        },
      },
      required: true,
    },`);
  }
  const responseDescription = http.summary ?? 'OK';
  const responseBody =
    http.successStatus === 204
      ? ''
      : `
      content: {
        'application/json': {
          schema: ${op.outputSchemaName}.jsonSchema,
        },
      },`;
  lines.push(`    responses: {
      '${http.successStatus}': {
        description: '${escapeString(responseDescription)}',${responseBody}
      },
    },`);
  return lines.join('\n');
}

function importLines(pairs: Array<[string, string]>): string[] {
  const grouped = new Map<string, Set<string>>();
  for (const [modulePath, exportName] of pairs) {
    const existing = grouped.get(modulePath) ?? new Set();
    existing.add(exportName);
    grouped.set(modulePath, existing);
  }
  return Array.from(grouped.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((modulePath) => {
      const exports = Array.from(grouped.get(modulePath)!)
        .sort((a, b) => a.localeCompare(b))
        .join(', ');
      return `import { ${exports} } from '${modulePath}';`;
    });
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function escapeString(value: string): string {
  return value.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`);
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function uncapitalize(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
