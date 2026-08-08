import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest } from '../types.ts';

export function emitToolsSurface(manifest: NormalizedManifest): string | null {
  const toolOps = Object.values(manifest.operations)
    .filter((op) => op.tool)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (toolOps.length === 0) {
    return null;
  }

  const className = `${capitalize(manifest.name)}${capitalize(manifest.version)}Tools`;

  // Resource for ToolSet
  const firstAuthResource =
    toolOps.find((op) => op.authorization?.resource)?.authorization?.resource ?? manifest.name;

  // Schema value imports (for .jsonSchema property)
  const schemaImportsMap = new Map<string, Set<string>>();
  for (const op of toolOps) {
    const s = manifest.schemas[op.inputSchemaName]!;
    const mod = s.relativeModulePathFromGen;
    const existing = schemaImportsMap.get(mod) ?? new Set();
    existing.add(op.inputSchemaName);
    schemaImportsMap.set(mod, existing);
  }

  const schemaImportLines: string[] = [];
  const sortedSchemaMods = Array.from(schemaImportsMap.keys()).sort();
  for (const mod of sortedSchemaMods) {
    const exports = Array.from(schemaImportsMap.get(mod)!).sort().join(', ');
    schemaImportLines.push(`import { ${exports} } from '${mod}';`);
  }

  // Handler imports
  const handlersMap = new Map<string, Set<string>>();
  for (const op of toolOps) {
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

  // Validation imports
  const validators = new Set<string>();
  for (const op of toolOps) {
    validators.add(`validate${op.inputSchemaName}`);
    validators.add(`validate${op.outputSchemaName}`);
  }
  const validatorsList = Array.from(validators).sort().join(',\n  ');

  // Handler injection properties
  const allHandlerExports = Array.from(new Set(toolOps.map((op) => op.handler.exportName))).sort();
  const handlerProps: string[] = [];
  const exportToPropMap = new Map<string, string>();

  for (const exportName of allHandlerExports) {
    const propName = allHandlerExports.length === 1 ? 'handlers' : uncapitalize(exportName);
    exportToPropMap.set(exportName, propName);
    handlerProps.push(`  @Component(${exportName})\n  private ${propName}!: ${exportName};`);
  }

  // Tool methods
  const methods: string[] = [];

  for (const op of toolOps) {
    const propName = exportToPropMap.get(op.handler.exportName)!;
    const action = op.authorization?.action ?? 'execute';

    methods.push(`  @Tool({
    name: '${op.tool!.name}',
    description: '${op.tool!.description}',
    inputSchema: ${op.inputSchemaName}.jsonSchema,
    auth: {
      action: '${action}',
    },
  })
  async ${op.name}(
    @ToolParam('${op.tool!.description}') input: unknown,
  ) {
    const command = validate${op.inputSchemaName}(input);
    return validate${op.outputSchemaName}(
      await this.${propName}.${op.handler.methodName}(command, { transport: 'ai-tool' }),
    );
  }`);
  }

  return `${OWNERSHIP_HEADER}

import {
  Tool,
  ToolParam,
  ToolSet,
} from '@di-framework/ai';
import {
  Component,
  Container,
} from '@di-framework/core/decorators';
${schemaImportLines.join('\n')}
${handlerImports.join('\n')}
import {
  ${validatorsList},
} from './contracts';

@ToolSet({
  auth: {
    resource: '${firstAuthResource}',
  },
})
@Container()
export class ${className} {
${handlerProps.join('\n\n')}

${methods.join('\n\n')}
}
`;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function uncapitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}
