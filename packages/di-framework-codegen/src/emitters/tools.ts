import { OWNERSHIP_HEADER } from '../ledger.ts';
import { compareCodeUnits, importLines } from '../order.ts';
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

  const schemaImportLines = importLines(
    toolOps.map((op) => {
      const schema = manifest.schemas[op.inputSchemaName]!;
      return [schema.relativeModulePathFromGen, op.inputSchemaName] as [string, string];
    }),
  );
  const handlerImports = importLines(
    toolOps.map((op) => [op.handler.relativeModulePathFromGen, op.handler.exportName]),
  );

  // Validation imports
  const validators = new Set<string>();
  for (const op of toolOps) {
    validators.add(`validate${op.inputSchemaName}`);
    validators.add(`validate${op.outputSchemaName}`);
  }
  const validatorsList = Array.from(validators).sort(compareCodeUnits).join(',\n  ');

  // Handler injection properties
  const allHandlerExports = Array.from(new Set(toolOps.map((op) => op.handler.exportName))).sort(
    compareCodeUnits,
  );
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
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function uncapitalize(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
