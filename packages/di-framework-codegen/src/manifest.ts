import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SchemaCodegenManifest } from './types.ts';

export interface LoadedManifest {
  manifest: SchemaCodegenManifest;
  filePath: string;
}

/** Utility to match glob patterns or direct file paths */
export function findManifestFiles(patterns: string[], cwd: string = process.cwd()): string[] {
  const filePaths = new Set<string>();

  for (const pattern of patterns) {
    const fullPath = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);

    // If it's a direct existing file
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      filePaths.add(fullPath);
      continue;
    }

    const bunGlobal = (globalThis as any).Bun;
    if (bunGlobal?.Glob) {
      const glob = new bunGlobal.Glob(pattern);
      for (const file of glob.scanSync({ cwd })) {
        const abs = isAbsolute(file) ? file : resolve(cwd, file);
        if (existsSync(abs) && statSync(abs).isFile()) {
          filePaths.add(abs);
        }
      }
    }
  }

  return Array.from(filePaths).sort();
}

export async function loadManifests(
  patterns: string[],
  cwd: string = process.cwd(),
): Promise<LoadedManifest[]> {
  const filePaths = findManifestFiles(patterns, cwd);
  const loaded: LoadedManifest[] = [];

  for (const filePath of filePaths) {
    const imported = await import(filePath);
    const manifest: SchemaCodegenManifest = imported.default ?? imported;

    validateManifestShape(manifest, filePath);
    loaded.push({ manifest, filePath });
  }

  return loaded;
}

export function validateManifestShape(
  manifest: any,
  filePath: string,
): asserts manifest is SchemaCodegenManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid manifest exported from ${filePath}: must be an object.`);
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error(`Invalid manifest in ${filePath}: 'name' must be a non-empty string.`);
  }

  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`Invalid manifest in ${filePath}: 'version' must be a non-empty string.`);
  }

  if (!manifest.schemas || typeof manifest.schemas !== 'object') {
    throw new Error(`Invalid manifest in ${filePath}: 'schemas' must be an object.`);
  }

  if (!manifest.operations || typeof manifest.operations !== 'object') {
    throw new Error(`Invalid manifest in ${filePath}: 'operations' must be an object.`);
  }

  for (const [opName, op] of Object.entries(manifest.operations as Record<string, any>)) {
    if (!op || typeof op !== 'object') {
      throw new Error(`Invalid operation '${opName}' in ${filePath}: must be an object.`);
    }
    if (typeof op.input !== 'string' || !op.input) {
      throw new Error(
        `Invalid operation '${opName}' in ${filePath}: missing 'input' schema string.`,
      );
    }
    if (typeof op.output !== 'string' || !op.output) {
      throw new Error(
        `Invalid operation '${opName}' in ${filePath}: missing 'output' schema string.`,
      );
    }
    if (
      !op.handler ||
      typeof op.handler !== 'object' ||
      typeof op.handler.module !== 'string' ||
      typeof op.handler.export !== 'string' ||
      typeof op.handler.method !== 'string'
    ) {
      throw new Error(
        `Invalid operation '${opName}' in ${filePath}: 'handler' must specify module, export, and method.`,
      );
    }
  }
}
