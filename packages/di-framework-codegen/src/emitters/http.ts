import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest } from '../types.ts';

export function emitHttpSurface(manifest: NormalizedManifest): string | null {
  const httpOps = Object.values(manifest.operations)
    .filter((op) => op.http)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (httpOps.length === 0 && !manifest.httpPrefix) {
    return null;
  }

  const controllerName = `${capitalize(manifest.name)}${capitalize(manifest.version)}HttpController`;

  // Handlers required
  const handlersMap = new Map<string, Set<string>>(); // modulePath -> Set of exportNames
  for (const op of httpOps) {
    const mod = op.handler.relativeModulePathFromGen;
    const existing = handlersMap.get(mod) ?? new Set();
    existing.add(op.handler.exportName);
    handlersMap.set(mod, existing);
  }

  const handlerImports: string[] = [];
  const sortedHandlerMods = Array.from(handlersMap.keys()).sort();
  for (const mod of sortedHandlerMods) {
    const exports = Array.from(handlersMap.get(mod)!).sort().join(', ');
    handlerImports.push(`import { ${exports} } from '${mod}';`);
  }

  // Validation functions required
  const validators = new Set<string>();
  for (const op of httpOps) {
    validators.add(`validate${op.inputSchemaName}`);
    validators.add(`validate${op.outputSchemaName}`);
  }
  const validatorsList = Array.from(validators).sort().join(',\n  ');

  // Handler component injection properties
  const allHandlerExports = Array.from(new Set(httpOps.map((op) => op.handler.exportName))).sort();
  const handlerProps: string[] = [];
  const exportToPropMap = new Map<string, string>();

  for (const exportName of allHandlerExports) {
    const propName = allHandlerExports.length === 1 ? 'handlers' : uncapitalize(exportName);
    exportToPropMap.set(exportName, propName);
    handlerProps.push(`  @Component(${exportName})\n  private ${propName}!: ${exportName};`);
  }

  // Route definitions
  const routeChains: string[] = [];
  const prefix = manifest.httpPrefix ?? '';
  const builderExpr = prefix
    ? `HttpRouter.builder().prefix('${prefix}').build()`
    : `HttpRouter.builder().build()`;

  for (const op of httpOps) {
    const method = op.http!.method.toLowerCase();
    const path = op.http!.path;
    const status = op.http!.successStatus;
    const propName = exportToPropMap.get(op.handler.exportName)!;

    const statusArg = status !== 200 ? `, { status: ${status} }` : '';

    const bodyRead =
      method === 'get' || method === 'head'
        ? `const body = (await request.json().catch(() => ({}))) as unknown;`
        : `const body = (await request.json()) as unknown;`;

    routeChains.push(`    .${method}('${path}', async (request: Request) => {
      ${bodyRead}
      const command = validate${op.inputSchemaName}(body);

      const output = await this.${propName}.${op.handler.methodName}(command, {
        transport: 'http',
      });

      return json(validate${op.outputSchemaName}(output)${statusArg});
    })`);
  }

  const prefixOpts = prefix ? `{\n  prefix: '${prefix}',\n}` : '';
  const routesCode = routeChains.length > 0 ? `\n${routeChains.join('\n')}` : '';

  return `${OWNERSHIP_HEADER}

import { Component } from '@di-framework/core/decorators';
import { HttpRouter, json } from '@di-framework/http';
${handlerImports.join('\n')}
import {
  ${validatorsList},
} from './contracts';

@HttpRouter(${prefixOpts})
export class ${controllerName} {
${handlerProps.join('\n\n')}

  route = ${builderExpr}${routesCode};
}
`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function uncapitalize(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
