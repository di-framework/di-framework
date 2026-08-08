import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { normalizeImportPath } from '../normalize.ts';
import type { GeneratedFileResult, NormalizedManifest } from '../types.ts';

export function initializeCompanions(
  manifests: NormalizedManifest[],
  cwd: string = process.cwd(),
): GeneratedFileResult[] {
  const results: GeneratedFileResult[] = [];

  for (const manifest of manifests) {
    for (const op of Object.values(manifest.operations)) {
      // 1. Companion Handler initialization
      const handlerPath = op.handler.modulePath;

      if (!existsSync(handlerPath)) {
        const handlerDir = dirname(handlerPath);
        if (!existsSync(handlerDir)) {
          mkdirSync(handlerDir, { recursive: true });
        }

        const inputSchemaObj = manifest.schemas[op.inputSchemaName]!;

        const schemaImportPath = normalizeImportPath(handlerDir, inputSchemaObj.modulePath);

        const schemaTypes = Array.from(new Set([op.inputSchemaName, op.outputSchemaName]))
          .sort()
          .join(',\n  ');

        const content = `import { Container } from '@di-framework/core/decorators';
import type {
  ${schemaTypes},
} from '${schemaImportPath}';

export type IngressContext = {
  transport: 'http' | 'event' | 'rpc' | 'ai-tool';
};

@Container()
export class ${op.handler.exportName} {
  async ${op.handler.methodName}(
    input: ${op.inputSchemaName},
    context: IngressContext,
  ): Promise<${op.outputSchemaName}> {
    void input;
    void context;
    throw new Error('Not implemented');
  }
}
`;

        writeFileSync(handlerPath, content, 'utf-8');

        results.push({
          path: handlerPath,
          relativePath: relative(cwd, handlerPath).replace(/\\/g, '/'),
          content,
          status: 'created',
        });
      }

      // 2. Policy Companion initialization
      if (op.authorization?.policyModulePath) {
        const policyPath = op.authorization.policyModulePath;

        if (!existsSync(policyPath)) {
          const policyDir = dirname(policyPath);
          if (!existsSync(policyDir)) {
            mkdirSync(policyDir, { recursive: true });
          }

          const policyClassName = `${capitalize(op.authorization.resource)}Policy`;

          const content = `import { Policy } from '@di-framework/authz';

@Policy('${op.authorization.resource}')
export class ${policyClassName} {
  // Add explicit allow/deny declarations here.
  // With no matching allow rule, authorization remains denied.
}
`;

          writeFileSync(policyPath, content, 'utf-8');

          results.push({
            path: policyPath,
            relativePath: relative(cwd, policyPath).replace(/\\/g, '/'),
            content,
            status: 'created',
          });
        }
      }
    }
  }

  return results;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
