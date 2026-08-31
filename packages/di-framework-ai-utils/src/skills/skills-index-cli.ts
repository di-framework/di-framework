import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandUserPath } from '../sandbox/paths.ts';
import { DEFAULT_SKILL_DIRECTORY_CANDIDATES } from './load-skills.ts';
import { type SkillEmbedder, TransformersJsSkillEmbedder } from './skill-embedder.ts';
import {
  assertSkillsIndexCurrent,
  type BuildSkillsIndexResult,
  DEFAULT_SKILLS_INDEX_BATCH_SIZE,
  DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS,
  DEFAULT_SKILLS_INDEX_CHUNK_TOKENS,
  DEFAULT_SKILLS_INDEX_FILE,
  DEFAULT_SKILLS_INDEX_THRESHOLD,
  DEFAULT_SKILLS_RETRIEVAL_LIMIT,
  LocalSkillIndexWriter,
  loadSkillsIndex,
  rankHybridSkillsIndex,
  SkillsIndex,
} from './skills-index.ts';
import { collectSkills } from './skills-tool.ts';

export type SkillsIndexCliCommand = 'build' | 'inspect' | 'validate' | 'query' | 'migrate';

export interface SkillsIndexCliOptions {
  readonly command: SkillsIndexCliCommand;
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly outputFile: string;
  readonly threshold: number;
  readonly retrievalLimit: number;
  readonly batchSize: number;
  readonly chunkTokens: number;
  readonly chunkOverlapTokens: number;
  readonly force: boolean;
  readonly ifPresent: boolean;
  readonly help: boolean;
  readonly inputFile?: string;
  readonly query?: string;
  readonly json: boolean;
}

export interface SkillsIndexCliIo {
  log(message: string): void;
  error(message: string): void;
}

export interface SkillsIndexCliRuntime {
  readonly embedder?: SkillEmbedder;
}

export const SKILLS_INDEX_CLI_HELP = `Build and diagnose a semantic Agent Skills index

Usage: di-skills-index [build|inspect|validate|query|migrate] [options]

Options:
  --skills-dir <path>       SKILL.md tree; repeatable
  --skill-file <path>       Individual SKILL.md; repeatable
  --input <path>            Existing index for diagnostics or migration
  --output <path>           Manifest output (default: ${DEFAULT_SKILLS_INDEX_FILE})
  --query <text>            Query text for the query command
  --json                    Emit stable schema-versioned JSON
  --threshold <count>       Index only above this skill count (default: ${DEFAULT_SKILLS_INDEX_THRESHOLD})
  --limit <count>           Runtime candidate count stored in metadata (default: ${DEFAULT_SKILLS_RETRIEVAL_LIMIT})
  --chunk-tokens <count>    Tokens per SKILL.md chunk (default: ${DEFAULT_SKILLS_INDEX_CHUNK_TOKENS})
  --chunk-overlap <count>   Token overlap (default: ${DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS})
  --batch-size <count>      Embedding batch size (default: ${DEFAULT_SKILLS_INDEX_BATCH_SIZE})
  --force                   Rebuild an unchanged index
  --if-present              Exit successfully when no skill source exists
  -h, --help                Show this help

With no skill paths, existing .claude/skills directories are used.`;

export function parseSkillsIndexCliArgs(args: readonly string[]): SkillsIndexCliOptions {
  const commands = new Set<SkillsIndexCliCommand>([
    'build',
    'inspect',
    'validate',
    'query',
    'migrate',
  ]);
  let command: SkillsIndexCliCommand = 'build';
  let start = 0;
  if (commands.has(args[0] as SkillsIndexCliCommand)) {
    command = args[0] as SkillsIndexCliCommand;
    start = 1;
  }
  const directories: string[] = [];
  const files: string[] = [];
  let outputFile = DEFAULT_SKILLS_INDEX_FILE;
  let threshold = DEFAULT_SKILLS_INDEX_THRESHOLD;
  let retrievalLimit = DEFAULT_SKILLS_RETRIEVAL_LIMIT;
  let batchSize = DEFAULT_SKILLS_INDEX_BATCH_SIZE;
  let chunkTokens = DEFAULT_SKILLS_INDEX_CHUNK_TOKENS;
  let chunkOverlapTokens = DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS;
  let force = false;
  let ifPresent = false;
  let help = false;
  let inputFile: string | undefined;
  let query: string | undefined;
  let json = false;

  for (let index = start; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case '--skills-dir':
      case '--directory':
        directories.push(value());
        break;
      case '--skill-file':
      case '--file':
        files.push(value());
        break;
      case '--output':
        outputFile = value();
        break;
      case '--input':
        inputFile = value();
        break;
      case '--query':
        query = value();
        break;
      case '--json':
        json = true;
        break;
      case '--threshold':
        threshold = integer(value(), flag, 0);
        break;
      case '--limit':
        retrievalLimit = integer(value(), flag, 1);
        break;
      case '--batch-size':
        batchSize = integer(value(), flag, 1);
        break;
      case '--chunk-tokens':
        chunkTokens = integer(value(), flag, 1);
        break;
      case '--chunk-overlap':
        chunkOverlapTokens = integer(value(), flag, 0);
        break;
      case '--force':
        force = true;
        break;
      case '--if-present':
        ifPresent = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (chunkOverlapTokens >= chunkTokens) {
    throw new Error('--chunk-overlap must be smaller than --chunk-tokens');
  }
  return {
    command,
    directories,
    files,
    outputFile,
    threshold,
    retrievalLimit,
    batchSize,
    chunkTokens,
    chunkOverlapTokens,
    force,
    ifPresent,
    help,
    inputFile,
    query,
    json,
  };
}

export async function runSkillsIndexCli(
  args: readonly string[] = process.argv.slice(2),
  io: SkillsIndexCliIo = console,
  cwd = process.cwd(),
  runtime: SkillsIndexCliRuntime = {},
): Promise<BuildSkillsIndexResult | Record<string, unknown> | undefined> {
  const options = parseSkillsIndexCliArgs(args);
  if (options.help) {
    io.log(SKILLS_INDEX_CLI_HELP);
    return undefined;
  }

  const inputFile = resolve(cwd, expandUserPath(options.inputFile ?? options.outputFile));
  if (options.command !== 'build') {
    const started = performance.now();
    const rssBefore = process.memoryUsage.rss();
    const index = loadSkillsIndex(inputFile);
    const loadMs = performance.now() - started;
    if (options.command === 'migrate') {
      const outputFile = resolve(cwd, expandUserPath(options.outputFile));
      new LocalSkillIndexWriter(outputFile).writeIndex(index);
      const result = diagnostic('migrate', {
        inputFile,
        outputFile,
        fromVersion: index.metadata.version,
        toVersion: 3,
        loadMs,
      });
      emitDiagnostic(io, result, options.json);
      return result;
    }
    if (options.command === 'inspect') {
      const result = diagnostic('inspect', {
        file: inputFile,
        metadata: index.metadata,
        manifestBytes: statSync(inputFile).size,
        vectorBytes: index.metadata.vectorBytes ?? 0,
        lexicalTerms: Object.keys(index.lexical?.postings ?? {}).length,
        loadMs,
        rssBytes: process.memoryUsage.rss() - rssBefore,
      });
      emitDiagnostic(io, result, options.json);
      return result;
    }
    if (options.command === 'validate') {
      const directories = options.directories.map((source) => resolve(cwd, expandUserPath(source)));
      const files = options.files.map((source) => resolve(cwd, expandUserPath(source)));
      let sourceDrift: string | undefined;
      if (directories.length > 0 || files.length > 0) {
        try {
          assertSkillsIndexCurrent(index, collectSkills({ directories, files }));
        } catch (error) {
          sourceDrift = error instanceof Error ? error.message : String(error);
        }
      }
      const result = diagnostic('validate', {
        file: inputFile,
        integrity: 'valid',
        sourceDrift: sourceDrift ?? null,
        ready: index.metadata.indexed,
        loadMs,
      });
      emitDiagnostic(io, result, options.json);
      if (sourceDrift) throw new Error(sourceDrift);
      return result;
    }
    if (!options.query?.trim()) throw new Error('query requires --query <text>');
    const embedder =
      runtime.embedder ??
      new TransformersJsSkillEmbedder({
        model: index.metadata.model,
        revision: index.metadata.revision,
      });
    const embedStarted = performance.now();
    const [vector] = await embedder.embed([options.query], { purpose: 'query' });
    if (!vector) throw new Error('Skill embedder did not return a query vector');
    const embedMs = performance.now() - embedStarted;
    const searchStarted = performance.now();
    const matches = rankHybridSkillsIndex(index, vector, options.query, {
      limit: options.retrievalLimit,
    });
    const searchMs = performance.now() - searchStarted;
    const result = diagnostic('query', {
      file: inputFile,
      decision: matches.length > 0 ? 'selected' : 'abstained',
      matches,
      timings: { loadMs, embedMs, searchMs, totalMs: performance.now() - started },
      rssBytes: process.memoryUsage.rss() - rssBefore,
    });
    emitDiagnostic(io, result, options.json);
    return result;
  }

  const resolveFromCwd = (source: string) => resolve(cwd, expandUserPath(source));
  const directoryCandidates =
    options.directories.length > 0 ? options.directories : DEFAULT_SKILL_DIRECTORY_CANDIDATES;
  const directories = directoryCandidates.map(resolveFromCwd);
  const files = options.files.map(resolveFromCwd);
  const existingSources = [...directories, ...files].filter(existsSync);
  if (existingSources.length === 0) {
    if (options.ifPresent) {
      io.log('No skill source exists; skipping semantic index build.');
      return undefined;
    }
    throw new Error('No skill source exists. Pass --skills-dir or --skill-file.');
  }

  let lastReported = 0;
  const started = performance.now();
  const builder = SkillsIndex.builder()
    .addSkillsDirectories(directories)
    .addSkillsFiles(files)
    .outputFile(resolve(cwd, expandUserPath(options.outputFile)))
    .threshold(options.threshold)
    .retrievalLimit(options.retrievalLimit)
    .batchSize(options.batchSize)
    .chunkTokens(options.chunkTokens)
    .chunkOverlapTokens(options.chunkOverlapTokens)
    .force(options.force);
  if (runtime.embedder) builder.embedder(runtime.embedder);
  const result = await builder
    .onProgress((completed, total) => {
      if (completed === total || completed - lastReported >= 256) {
        io.log(`embedded ${completed}/${total} chunks`);
        lastReported = completed;
      }
    })
    .build();
  const bytes = statSync(result.outputFile).size;
  const state = result.unchanged
    ? 'unchanged'
    : result.indexed
      ? `${result.chunkCount} chunks x ${result.dimensions} dimensions`
      : 'below threshold; metadata only';
  io.log(
    `skills index: ${result.skillCount} skills, ${state}, ${bytes} bytes, ${(performance.now() - started).toFixed(1)} ms`,
  );
  io.log(result.outputFile);
  return result;
}

function diagnostic(command: SkillsIndexCliCommand, fields: Record<string, unknown>) {
  return { schema: '@di-framework/skills-index-diagnostic', version: 1, command, ...fields };
}

function emitDiagnostic(
  io: SkillsIndexCliIo,
  result: Record<string, unknown>,
  _json: boolean,
): void {
  // Diagnostics are JSON in both modes so automation never needs to scrape prose.
  io.log(JSON.stringify(result));
}

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    const expectation = minimum === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new Error(`${flag} must be ${expectation}`);
  }
  return parsed;
}
