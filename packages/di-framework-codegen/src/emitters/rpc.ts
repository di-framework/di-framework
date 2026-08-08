import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest, SchemaCodegenManifestRpcField } from '../types.ts';

export function emitRpcSurface(manifest: NormalizedManifest): string | null {
  const rpcOps = Object.values(manifest.operations)
    .filter((op) => op.rpc)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (rpcOps.length === 0) {
    return null;
  }

  const serviceClassName = `${capitalize(manifest.name)}${capitalize(manifest.version)}RpcService`;

  // Handlers required
  const handlersMap = new Map<string, Set<string>>();
  for (const op of rpcOps) {
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

  // Validators required
  const validators = new Set<string>();
  for (const op of rpcOps) {
    validators.add(`validate${op.inputSchemaName}`);
    validators.add(`validate${op.outputSchemaName}`);
  }
  const validatorsList = Array.from(validators).sort().join(',\n  ');

  // Handler injection properties
  const allHandlerExports = Array.from(new Set(rpcOps.map((op) => op.handler.exportName))).sort();
  const handlerProps: string[] = [];
  const exportToPropMap = new Map<string, string>();

  for (const exportName of allHandlerExports) {
    const propName = allHandlerExports.length === 1 ? 'handlers' : uncapitalize(exportName);
    exportToPropMap.set(exportName, propName);
    handlerProps.push(`  @Component(${exportName})\n  private ${propName}!: ${exportName};`);
  }

  const messageClasses: string[] = [];
  const serviceMethods: string[] = [];

  const rpcPackage = rpcOps[0]!.rpc!.package;

  for (const op of rpcOps) {
    const reqClassName = `${capitalize(op.name)}Request`;
    const resClassName = `${capitalize(op.outputSchemaName)}Message`;

    // Emit Request Message
    const reqFields = emitMessageFields(op.rpc!.inputFields);
    messageClasses.push(`@RpcMessage()\nexport class ${reqClassName} {\n${reqFields}\n}`);

    // Emit Response Message
    const resFields = emitMessageFields(op.rpc!.outputFields);
    messageClasses.push(`@RpcMessage()\nexport class ${resClassName} {\n${resFields}\n}`);

    const propName = exportToPropMap.get(op.handler.exportName)!;

    serviceMethods.push(`  @RpcMethod({
    input: () => ${reqClassName},
    output: () => ${resClassName},
  })
  async ${op.name}(input: ${reqClassName}): Promise<${resClassName}> {
    const command = validate${op.inputSchemaName}(input);
    return validate${op.outputSchemaName}(
      await this.${propName}.${op.handler.methodName}(command, { transport: 'rpc' }),
    );
  }`);
  }

  return `${OWNERSHIP_HEADER}

import { Component } from '@di-framework/core/decorators';
import {
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcService,
} from '@di-framework/rpc';
${handlerImports.join('\n')}
import {
  ${validatorsList},
} from './contracts';

${messageClasses.join('\n\n')}

@RpcService({ package: '${rpcPackage}' })
export class ${serviceClassName} {
${handlerProps.join('\n\n')}

${serviceMethods.join('\n\n')}
}
`;
}

function emitMessageFields(fields: Record<string, SchemaCodegenManifestRpcField>): string {
  const sortedKeys = Object.keys(fields).sort(
    (a, b) => (fields[a]?.number ?? 0) - (fields[b]?.number ?? 0),
  );

  return sortedKeys
    .map((key) => {
      const f = fields[key]!;
      const tsType = getTsType(f.type);
      if (f.type === 'string' || !f.type) {
        return `  @RpcField(${f.number})\n  ${key}!: ${tsType};`;
      }
      return `  @RpcField({ number: ${f.number}, type: '${f.type}' })\n  ${key}!: ${tsType};`;
    })
    .join('\n\n');
}

function getTsType(rpcType: string): string {
  switch (rpcType.toLowerCase()) {
    case 'double':
    case 'float':
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
    case 'number':
      return 'number';
    case 'bool':
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function uncapitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}
