import { OWNERSHIP_HEADER } from '../ledger.ts';
import type { NormalizedManifest } from '../types.ts';

export function emitValidationSurface(manifest: NormalizedManifest): string {
  const schemaNames = Object.keys(manifest.schemas).sort();

  // Group schemas by relative module path
  const modulesMap = new Map<string, string[]>();
  for (const name of schemaNames) {
    const s = manifest.schemas[name]!;
    const mod = s.relativeModulePathFromGen;
    const existing = modulesMap.get(mod) ?? [];
    existing.push(name);
    modulesMap.set(mod, existing);
  }

  const importLines: string[] = [];
  const sortedModules = Array.from(modulesMap.keys()).sort();

  for (const mod of sortedModules) {
    const names = modulesMap.get(mod)!.sort();
    const typeList = names.join(', ');
    const valueList = names.map((n) => `${n} as ${n}Schema`).join(', ');

    importLines.push(`import type { ${typeList} } from '${mod}';`);
    importLines.push(`import { ${valueList} } from '${mod}';`);
  }

  const validationFns: string[] = [];
  for (const name of schemaNames) {
    validationFns.push(
      `export function validate${name}(input: unknown): ${name} {\n  return ${name}Schema.parse(input);\n}`,
    );
  }

  return `${OWNERSHIP_HEADER}

${importLines.join('\n')}

${validationFns.join('\n\n')}
`;
}
