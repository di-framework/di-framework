#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import type { CliIo, CommandResult } from '../../command';
import { CommandFailure } from '../../command';

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
      const value = arg.slice('--pretty='.length);
      if (value !== '0' && value !== '1') {
        throw new CommandFailure('INVALID_USAGE', `Invalid --pretty value: ${value}`, 2, {
          argument: arg,
        });
      }
      pretty = value === '1';
      continue;
    }
    if (arg.startsWith('--from=')) {
      const v = arg.slice('--from='.length);
      if (v !== 'cwd' && v !== 'script') {
        throw new CommandFailure('INVALID_USAGE', `Invalid --from value: ${v}`, 2, {
          argument: arg,
        });
      }
      from = v;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CommandFailure('INVALID_USAGE', `Unknown mx typecheck argument: ${arg}`, 2, {
        argument: arg,
      });
    }
    if (!tsconfigPath) {
      tsconfigPath = arg;
      continue;
    }
    throw new CommandFailure('INVALID_USAGE', `Unexpected mx typecheck argument: ${arg}`, 2, {
      argument: arg,
    });
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
    if (ts.sys.fileExists(gitPath) || ts.sys.directoryExists(gitPath)) {
      break;
    }

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

export async function typecheck(
  argv: string[] = process.argv,
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<CommandResult> {
  const args = parseArgs(argv);

  // Start search either from where you run it, or from where the script lives.
  const startDir =
    args.from === 'script'
      ? path.dirname(path.resolve(process.argv[1] ?? process.cwd()))
      : process.cwd();

  const tsconfigPath = args.tsconfigPath
    ? path.resolve(process.cwd(), args.tsconfigPath)
    : findTopmostTsconfig(startDir);

  if (!tsconfigPath) {
    throw new CommandFailure('INVALID_CONFIG', 'Could not find tsconfig.json', 2);
  }

  const cwd = process.cwd();

  const configFileText = ts.sys.readFile(tsconfigPath);
  if (!configFileText) {
    throw new CommandFailure('INVALID_CONFIG', `Failed to read tsconfig: ${tsconfigPath}`, 2);
  }

  const configJson = ts.parseConfigFileTextToJson(tsconfigPath, configFileText);
  if (configJson.error) {
    const msg = ts.formatDiagnosticsWithColorAndContext([configJson.error], {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => cwd,
      getNewLine: () => ts.sys.newLine,
    });
    throw new CommandFailure('INVALID_CONFIG', 'Failed to parse tsconfig.json', 2, {
      diagnostic: args.pretty ? msg : stripAnsi(msg),
    });
  }

  const parsed = ts.parseJsonConfigFileContent(
    configJson.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );

  if (parsed.errors.length) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => cwd,
      getNewLine: () => ts.sys.newLine,
    };
    const diagnostics = parsed.errors.map((d) => {
      const msg = formatDiagnostic(d, host);
      return args.pretty ? msg : stripAnsi(msg);
    });
    throw new CommandFailure('INVALID_CONFIG', 'tsconfig parsing produced diagnostics', 2, {
      diagnostics,
    });
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
  io.stdout.write(`ℹ️ Using tsconfig: ${tsconfigPath}\n`);
  io.stdout.write(`ℹ️ Checking ${servicesHost.getScriptFileNames().length} file(s)\n`);

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
      io.stderr.write(args.pretty ? msg : stripAnsi(msg));
    }
  }

  if (errors.length) {
    throw new CommandFailure('TYPECHECK_FAILED', `${errors.length} typecheck error(s)`, 1, {
      errors: errors.length,
      warnings: warnings.length,
      tsconfigPath,
    });
  }

  const text = `Typecheck passed (${warnings.length ? `${warnings.length} warning(s)` : 'no warnings'}).`;
  return {
    data: {
      errors: 0,
      files: servicesHost.getScriptFileNames().length,
      tsconfigPath,
      warnings: warnings.length,
    },
    text,
  };
}

export function runMxTypecheck(args: readonly string[], io: CliIo): Promise<CommandResult> {
  return typecheck(['bun', 'typecheck', ...args], io);
}

/** Standalone boundary; reports failures without terminating an embedding process. */
export async function runTypecheckMain(
  isMain = import.meta.main,
  start: (args: string[], io: CliIo) => Promise<CommandResult> = typecheck,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  if (!isMain) return;
  try {
    await start(process.argv, { stdout: process.stdout, stderr: process.stderr });
  } catch (error) {
    process.stderr.write(
      `${error instanceof CommandFailure ? error.message : `❌ Fatal error while running typecheck: ${error instanceof Error ? error.message : String(error)}`}\n`,
    );
    setExitCode(error instanceof CommandFailure ? error.exitCode : 2);
  }
}

void runTypecheckMain();
