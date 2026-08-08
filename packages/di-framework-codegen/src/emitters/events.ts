import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest } from '../types.ts';

export function emitEventsSurface(manifest: NormalizedManifest): string | null {
  const eventOps = Object.values(manifest.operations)
    .filter((op) => op.events?.inbound || op.events?.outbound)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (eventOps.length === 0) {
    return null;
  }

  const className = `${capitalize(manifest.name)}${capitalize(manifest.version)}Events`;

  const hasInbound = eventOps.some((op) => op.events?.inbound);
  const hasOutbound = eventOps.some((op) => op.events?.outbound);

  const eventImports = ['EventBridge'];
  if (hasInbound) eventImports.push('Inbound');
  if (hasOutbound) eventImports.push('Outbound');
  eventImports.sort();

  const validators = new Set<string>();
  for (const op of eventOps) {
    if (op.events?.inbound) {
      validators.add(`validate${op.inputSchemaName}`);
    }
  }
  const validatorsList = Array.from(validators).sort().join(', ');

  const properties: string[] = [];

  for (const op of eventOps) {
    if (op.events?.inbound) {
      properties.push(`  @Inbound({
    topic: '${op.events.inbound.topic}',
    event: '${op.events.inbound.event}',
    validate: validate${op.inputSchemaName},
  })
  inbound${capitalize(op.name)}!: void;`);
    }

    if (op.events?.outbound) {
      properties.push(`  @Outbound('${op.events.outbound.event}', {
    topic: '${op.events.outbound.topic}',
  })
  outbound${capitalize(op.name)}!: void;`);
    }
  }

  const validatorImportLine = validatorsList
    ? `import { ${validatorsList} } from './contracts';\n`
    : '';

  return `${OWNERSHIP_HEADER}

import {
  ${eventImports.join(',\n  ')},
} from '@di-framework/events';
${validatorImportLine}
@EventBridge()
export class ${className} {
${properties.join('\n\n')}
}
`;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
