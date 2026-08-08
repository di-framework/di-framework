import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CodegenConfig } from './types.ts';

export interface ResolvedCodegenConfig {
  manifests: string[];
  outDir: string;
  companionsDir: string;
  policiesDir: string;
  ledgerPath: string;
  configFilePath?: string;
}

const DEFAULT_CONFIG_CANDIDATES = [
  'di-framework.codegen.ts',
  'di-framework.codegen.js',
  'codegen.config.ts',
  'codegen.config.js',
];

export async function loadConfig(
  configInput?: CodegenConfig | string,
  cwd: string = process.cwd(),
): Promise<ResolvedCodegenConfig> {
  let rawConfig: CodegenConfig | undefined;
  let configFilePath: string | undefined;

  if (typeof configInput === 'object' && configInput !== null) {
    rawConfig = configInput;
  } else if (typeof configInput === 'string') {
    const fullPath = isAbsolute(configInput) ? configInput : resolve(cwd, configInput);
    if (!existsSync(fullPath)) {
      throw new Error(`Config file not found at: ${fullPath}`);
    }
    configFilePath = fullPath;
    const imported = await import(fullPath);
    rawConfig = imported.default ?? imported;
  } else {
    // Search for candidate config file in cwd
    for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
      const fullPath = join(cwd, candidate);
      if (existsSync(fullPath)) {
        configFilePath = fullPath;
        const imported = await import(fullPath);
        rawConfig = imported.default ?? imported;
        break;
      }
    }
  }

  // Fallback defaults if no config file or object provided
  const manifestsInput = rawConfig?.manifests ?? ['./src/contracts/**/*.codegen.ts'];
  const manifests = Array.isArray(manifestsInput) ? manifestsInput : [manifestsInput];

  const outDirRel = rawConfig?.outDir ?? './src/generated';
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);

  const companionsDirRel = rawConfig?.companionsDir ?? './src/handlers';
  const companionsDir = isAbsolute(companionsDirRel)
    ? companionsDirRel
    : resolve(cwd, companionsDirRel);

  const policiesDirRel = rawConfig?.policiesDir ?? './src/policies';
  const policiesDir = isAbsolute(policiesDirRel) ? policiesDirRel : resolve(cwd, policiesDirRel);

  const ledgerPathRel = rawConfig?.ledgerPath ?? join(outDirRel, '.codegen-ledger.json');
  const ledgerPath = isAbsolute(ledgerPathRel) ? ledgerPathRel : resolve(cwd, ledgerPathRel);

  return {
    manifests,
    outDir,
    companionsDir,
    policiesDir,
    ledgerPath,
    configFilePath,
  };
}
