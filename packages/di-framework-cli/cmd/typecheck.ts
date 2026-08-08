#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

type Args = {
  tsconfigPath?: string;
  pretty: boolean;
  from: 'cwd' | 'script';
};

export function parseArgs(argv: string[]): Args {
  let tsconfigPath: string | undefined;
  let pretty = Boolean(process.stdout.isTTY);
  let from: Args['from'] = 'cwd';

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--pretty=')) {
      pretty = arg.split('=')[1] !== '0';
      continue;
    }
    if (arg.startsWith('--from=')) {
      const v = arg.split('=')[1];
      if (v === 'cwd' || v === 'script') from = v;
      continue;
    }
    if (!arg.startsWith('-') && !tsconfigPath) {
      tsconfigPath = arg;
    }
  }

  return { tsconfigPath, pretty, from };
}

/**
 * Find the *highest* (topmost) tsconfig.json above a starting directory.
 * This is handy for monorepos where each package may have its own tsconfig.json
 * but you want the repo root solution config.
 */
export function findTopmostTsconfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  let lastFound: string | undefined;

  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (ts.sys.fileExists(candidate)) lastFound = candidate;

    const gitPath = path.join(dir, '.git');
    if (ts.sys.fileExists(gitPath) || ts.sys.directoryExists(gitPath)) break;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return lastFound;
}

function formatDiagnostic(d: ts.Diagnostic, host: ts.FormatDiagnosticsHost): string {
  return ts.formatDiagnosticsWithColorAndContext([d], host);
}

function stripAnsi(s: string) {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export async function typecheck() {
  const args = parseArgs(process.argv);

  // Start search either from where you run it, or from where the script lives.
  const startDir =
    args.from === 'script'
      ? path.dirname(path.resolve(process.argv[1] ?? process.cwd()))
      : process.cwd();

  const tsconfigPath = args.tsconfigPath
    ? path.resolve(process.cwd(), args.tsconfigPath)
    : findTopmostTsconfig(startDir);

  if (!tsconfigPath) {
    console.error(
      '❌ Could not find tsconfig.json. Pass a path as the first argument, or run with --from=script.',
    );
    process.exit(2);
  }

  const cwd = process.cwd();

  const configFileText = ts.sys.readFile(tsconfigPath);
  if (!configFileText) {
    console.error(`❌ Failed to read tsconfig: ${tsconfigPath}`);
    process.exit(2);
  }

  const configJson = ts.parseConfigFileTextToJson(tsconfigPath, configFileText);
  if (configJson.error) {
    console.error('❌ Failed to parse tsconfig.json:');
    const msg = ts.formatDiagnosticsWithColorAndContext([configJson.error], {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => cwd,
      getNewLine: () => ts.sys.newLine,
    });
    console.error(args.pretty ? msg : stripAnsi(msg));
    process.exit(2);
  }

  const parsed = ts.parseJsonConfigFileContent(
    configJson.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );

  if (parsed.errors.length) {
    console.error('❌ tsconfig parsing produced diagnostics:');
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => cwd,
      getNewLine: () => ts.sys.newLine,
    };
    for (const d of parsed.errors) {
      const msg = formatDiagnostic(d, host);
      console.error(args.pretty ? msg : stripAnsi(msg));
    }
    process.exit(2);
  }

  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => cwd,
    getNewLine: () => ts.sys.newLine,
  };

  const files = new Map<string, { version: number; text?: string }>();
  for (const f of parsed.fileNames) files.set(path.resolve(f), { version: 0 });

  const servicesHost: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getCurrentDirectory: () => cwd,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),

    getScriptFileNames: () => Array.from(files.keys()),
    getScriptVersion: (fileName) => String(files.get(path.resolve(fileName))?.version ?? 0),
    getScriptSnapshot: (fileName) => {
      const abs = path.resolve(fileName);
      const cached = files.get(abs);
      if (cached?.text !== undefined) return ts.ScriptSnapshot.fromString(cached.text);

      const text = ts.sys.readFile(abs);
      if (text === undefined) return undefined;

      if (cached) cached.text = text;
      else files.set(abs, { version: 0, text });

      return ts.ScriptSnapshot.fromString(text);
    },

    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };

  const languageService = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());

  const all: ts.Diagnostic[] = [];
  all.push(...languageService.getCompilerOptionsDiagnostics());
  for (const fileName of servicesHost.getScriptFileNames()) {
    all.push(...languageService.getSyntacticDiagnostics(fileName));
    all.push(...languageService.getSemanticDiagnostics(fileName));
  }

  const errors = all.filter((d) => d.category === ts.DiagnosticCategory.Error);
  const warnings = all.filter((d) => d.category === ts.DiagnosticCategory.Warning);

  // Small banner so you can tell which config actually drove the check.
  console.log(`ℹ️ Using tsconfig: ${tsconfigPath}`);
  console.log(`ℹ️ Checking ${servicesHost.getScriptFileNames().length} file(s)`);

  if (all.length) {
    const sorted = [
      ...errors,
      ...warnings,
      ...all.filter(
        (d) =>
          d.category !== ts.DiagnosticCategory.Error &&
          d.category !== ts.DiagnosticCategory.Warning,
      ),
    ];
    for (const d of sorted) {
      const msg = formatDiagnostic(d, formatHost);
      console.error(args.pretty ? msg : stripAnsi(msg));
    }
  }

  if (errors.length) {
    console.error(`❌ Typecheck failed: ${errors.length} error(s).`);
    process.exit(1);
  }

  console.log(
    `✅ Typecheck passed (${warnings.length ? `${warnings.length} warning(s)` : 'no warnings'}).`,
  );
  process.exit(0);
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handleTypecheckFailure(err: unknown): never {
  console.error('❌ Fatal error while running typecheck:', err);
  process.exit(2);
}

/** CLI main gate — `isMain` is injectable so tests can cover the entry path. */
export function runTypecheckMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => typecheck().catch(handleTypecheckFailure),
): void {
  if (isMain) {
    void start();
  }
}

runTypecheckMain();
