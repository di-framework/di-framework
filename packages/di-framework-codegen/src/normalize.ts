import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ResolvedCodegenConfig } from './config.ts';
import type {
  LoadedManifest,
  NormalizedManifest,
  NormalizedOperation,
  NormalizedSchema,
  RuntimeSchema,
  SchemaCodegenManifest,
  SchemaCodegenManifestRpcField,
} from './types.ts';

export function normalizeImportPath(fromDir: string, targetPathWithoutExt: string): string {
  // Strip .ts, .js, .d.ts extension if present
  const cleanTarget = targetPathWithoutExt.replace(/\.(ts|js|d\.ts)$/, '');

  let rel = relative(fromDir, cleanTarget).replace(/\\/g, '/');
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return rel;
}

export function normalizeManifest(
  input: LoadedManifest | { manifest: SchemaCodegenManifest; filePath: string },
  config: ResolvedCodegenConfig,
): NormalizedManifest {
  const { manifest, filePath } = input;
  const manifestDir = dirname(resolve(filePath));

  const outputDir = resolve(config.outDir, manifest.name, manifest.version);

  // 1. Normalize Schemas
  const schemas: Record<string, NormalizedSchema> = {};
  for (const schemaName of Object.keys(manifest.schemas).sort()) {
    const rawSchema = manifest.schemas[schemaName]!;
    let runtimeSchema: RuntimeSchema;
    let explicitModule: string | undefined;

    if ('parse' in rawSchema && 'jsonSchema' in rawSchema) {
      runtimeSchema = rawSchema as RuntimeSchema;
    } else if ('schema' in rawSchema && (rawSchema as any).schema) {
      runtimeSchema = (rawSchema as any).schema;
      explicitModule = (rawSchema as any).module;
    } else {
      throw new Error(
        `Invalid schema definition for '${schemaName}' in manifest '${manifest.name}'`,
      );
    }

    const rawModulePath = explicitModule ?? `./${manifest.name}.schemas`;
    const modulePath = isAbsolute(rawModulePath)
      ? rawModulePath
      : resolve(manifestDir, rawModulePath);

    const relativeModulePathFromGen = normalizeImportPath(outputDir, modulePath);

    schemas[schemaName] = {
      name: schemaName,
      runtimeSchema,
      modulePath,
      relativeModulePathFromGen,
    };
  }

  // 2. Normalize Operations
  const operations: Record<string, NormalizedOperation> = {};
  for (const opName of Object.keys(manifest.operations).sort()) {
    const op = manifest.operations[opName]!;

    if (!schemas[op.input]) {
      throw new Error(
        `Operation '${opName}' references unknown input schema '${op.input}' in manifest '${manifest.name}'`,
      );
    }
    if (!schemas[op.output]) {
      throw new Error(
        `Operation '${opName}' references unknown output schema '${op.output}' in manifest '${manifest.name}'`,
      );
    }

    // Handler normalization
    const handlerRawModule = op.handler.module;
    const handlerModulePath = isAbsolute(handlerRawModule)
      ? handlerRawModule
      : resolve(manifestDir, handlerRawModule);
    const handlerRelative = normalizeImportPath(outputDir, handlerModulePath);

    const normOp: NormalizedOperation = {
      name: opName,
      inputSchemaName: op.input,
      outputSchemaName: op.output,
      handler: {
        modulePath: handlerModulePath,
        relativeModulePathFromGen: handlerRelative,
        exportName: op.handler.export,
        methodName: op.handler.method,
      },
    };

    // HTTP normalization
    if (op.http) {
      normOp.http = {
        method: op.http.method.toUpperCase(),
        path: op.http.path,
        successStatus:
          op.http.successStatus ?? (op.http.method.toUpperCase() === 'POST' ? 201 : 200),
        summary: op.http.summary,
        description: op.http.description,
      };
    }

    // Events normalization
    if (op.events) {
      normOp.events = {};
      if (op.events.inbound) {
        normOp.events.inbound = {
          topic: op.events.inbound.topic,
          event: op.events.inbound.event,
        };
      }
      if (op.events.outbound) {
        normOp.events.outbound = {
          topic: op.events.outbound.topic,
          event: op.events.outbound.event,
        };
      }
    }

    // RPC normalization
    if (op.rpc) {
      const normalizeFields = (
        fields?: Record<string, SchemaCodegenManifestRpcField | number>,
      ): Record<string, SchemaCodegenManifestRpcField> => {
        const res: Record<string, SchemaCodegenManifestRpcField> = {};
        if (!fields) return res;
        for (const fieldKey of Object.keys(fields).sort()) {
          const val = fields[fieldKey]!;
          if (typeof val === 'number') {
            res[fieldKey] = { number: val, type: 'string' };
          } else {
            res[fieldKey] = { number: val.number, type: val.type };
          }
        }
        return res;
      };

      normOp.rpc = {
        package: op.rpc.package,
        service: op.rpc.service ?? `${capitalize(manifest.name)}Service`,
        method: op.rpc.method ?? capitalize(opName),
        inputFields: normalizeFields(op.rpc.inputFields),
        outputFields: normalizeFields(op.rpc.outputFields),
      };
    }

    // Authorization normalization
    if (op.authorization) {
      const policyModulePath = op.authorization.policyModule
        ? isAbsolute(op.authorization.policyModule)
          ? op.authorization.policyModule
          : resolve(manifestDir, op.authorization.policyModule)
        : resolve(config.policiesDir, `${op.authorization.resource}.policy.ts`);

      const relativePolicyModulePathFromGen = normalizeImportPath(outputDir, policyModulePath);

      normOp.authorization = {
        resource: op.authorization.resource,
        action: op.authorization.action,
        policyModulePath,
        relativePolicyModulePathFromGen,
      };
    }

    // Tool normalization
    if (op.tool) {
      normOp.tool = {
        name: op.tool.name,
        description: op.tool.description,
      };
    }

    operations[opName] = normOp;
  }

  return {
    name: manifest.name,
    version: manifest.version,
    manifestFilePath: filePath,
    outputDir,
    httpPrefix: manifest.http?.prefix,
    managedByDi: manifest.http?.managedByDi ?? true,
    schemas,
    operations,
  };
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
