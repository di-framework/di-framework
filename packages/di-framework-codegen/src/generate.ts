import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { emitEventsSurface } from './emitters/events.ts';
import { emitHttpSurface } from './emitters/http.ts';
import { initializeCompanions } from './emitters/init.ts';
import { emitRpcSurface } from './emitters/rpc.ts';
import { emitToolsSurface } from './emitters/tools.ts';
import { emitValidationSurface } from './emitters/validation.ts';
import { hasOwnershipHeader, loadLedger, saveLedger } from './ledger.ts';
import { loadManifests } from './manifest.ts';
import { normalizeManifest } from './normalize.ts';
import type {
  GeneratedFileResult,
  GenerateOptions,
  GenerateResult,
  NormalizedManifest,
} from './types.ts';

export async function generate(options: GenerateOptions = {}): Promise<GenerateResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await loadConfig(options.config, cwd);

  if (options.outDir) {
    config.outDir = resolve(cwd, options.outDir);
    config.ledgerPath = resolve(config.outDir, '.codegen-ledger.json');
  }

  // 1. Discover and load manifests
  let normalizedManifests: NormalizedManifest[] = [];

  if (options.manifests && options.manifests.length > 0) {
    const dummyPath = config.configFilePath ?? resolve(cwd, 'src/contracts/manifest.codegen.ts');
    normalizedManifests = options.manifests.map((manifest) =>
      normalizeManifest({ manifest, filePath: dummyPath }, config),
    );
  } else {
    const loaded = await loadManifests(config.manifests, cwd);
    normalizedManifests = loaded.map((item) => normalizeManifest(item, config));
  }

  const diagnostics: string[] = [];
  const files: GeneratedFileResult[] = [];

  // 2. Companion Initialization (--init)
  if (options.init) {
    const companionResults = initializeCompanions(normalizedManifests, cwd);
    files.push(...companionResults);
  }

  // 3. Emit Surface Files
  const pendingGenerated = new Map<string, string>(); // absPath -> content

  for (const manifest of normalizedManifests) {
    const genDir = manifest.outputDir;

    // Validation contracts
    const validationCode = emitValidationSurface(manifest);
    pendingGenerated.set(resolve(genDir, 'contracts.ts'), validationCode);

    // HTTP Router / OpenAPI
    const httpCode = emitHttpSurface(manifest);
    if (httpCode) {
      pendingGenerated.set(resolve(genDir, 'http.ts'), httpCode);
    }

    // Events
    const eventsCode = emitEventsSurface(manifest);
    if (eventsCode) {
      pendingGenerated.set(resolve(genDir, 'events.ts'), eventsCode);
    }

    // RPC (opt-in)
    const rpcCode = emitRpcSurface(manifest);
    if (rpcCode) {
      pendingGenerated.set(resolve(genDir, 'rpc.ts'), rpcCode);
    }

    // AI Tools (opt-in)
    const toolsCode = emitToolsSurface(manifest);
    if (toolsCode) {
      pendingGenerated.set(resolve(genDir, 'tools.ts'), toolsCode);
    }
  }

  // 4. Stale Files Check via Ledger
  const oldLedger = loadLedger(config.ledgerPath);
  const newAbsPaths = new Set(Array.from(pendingGenerated.keys()).map((p) => resolve(p)));
  const staleAbsPaths: string[] = [];

  for (const fileInLedger of oldLedger.generatedFiles) {
    const absPath = isAbsolute(fileInLedger) ? fileInLedger : resolve(cwd, fileInLedger);
    if (!newAbsPaths.has(absPath) && existsSync(absPath)) {
      staleAbsPaths.push(absPath);
    }
  }

  const isCheckMode = Boolean(options.check);
  let drifted = false;

  // Process generated surface files
  for (const [absPath, content] of pendingGenerated.entries()) {
    const relPath = relative(cwd, absPath).replace(/\\/g, '/');

    if (!existsSync(absPath)) {
      if (isCheckMode) {
        drifted = true;
        diagnostics.push(`Missing generated file: ${relPath}`);
        files.push({
          path: absPath,
          relativePath: relPath,
          content,
          status: 'drifted',
        });
      } else {
        files.push({
          path: absPath,
          relativePath: relPath,
          content,
          status: 'created',
        });
      }
    } else {
      const existingContent = readFileSync(absPath, 'utf-8');
      if (existingContent !== content) {
        if (isCheckMode) {
          drifted = true;
          diagnostics.push(`Drifted content in generated file: ${relPath}`);
          files.push({
            path: absPath,
            relativePath: relPath,
            content,
            status: 'drifted',
          });
        } else {
          files.push({
            path: absPath,
            relativePath: relPath,
            content,
            status: 'updated',
          });
        }
      } else {
        files.push({
          path: absPath,
          relativePath: relPath,
          content,
          status: 'unchanged',
        });
      }
    }
  }

  // Process stale files
  for (const stalePath of staleAbsPaths) {
    const relPath = relative(cwd, stalePath).replace(/\\/g, '/');
    const content = readFileSync(stalePath, 'utf-8');

    if (!hasOwnershipHeader(content)) {
      diagnostics.push(`Skipping cleanup for ${relPath}: missing codegen ownership header.`);
      continue;
    }

    if (isCheckMode) {
      drifted = true;
      diagnostics.push(`Stale generated file present: ${relPath}`);
      files.push({
        path: stalePath,
        relativePath: relPath,
        content: '',
        status: 'drifted',
      });
    } else {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(stalePath);
      files.push({
        path: stalePath,
        relativePath: relPath,
        content: '',
        status: 'deleted',
      });
    }
  }

  // Write mode: write files and save ledger
  if (!isCheckMode) {
    for (const f of files) {
      if (f.status === 'created' || f.status === 'updated') {
        const dir = dirname(f.path);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(f.path, f.content, 'utf-8');
      }
    }

    const finalGeneratedList = files
      .filter((f) => f.status !== 'deleted')
      .map((f) => relative(cwd, f.path).replace(/\\/g, '/'));

    saveLedger(config.ledgerPath, finalGeneratedList);
  }

  return {
    success: !drifted,
    drifted,
    files,
    ledgerPath: config.ledgerPath,
    diagnostics,
  };
}
