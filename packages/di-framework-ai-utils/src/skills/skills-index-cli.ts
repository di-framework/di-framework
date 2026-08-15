import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandUserPath } from '../sandbox/paths.ts';
import { DEFAULT_SKILL_DIRECTORY_CANDIDATES } from './load-skills.ts';
import {
  type BuildSkillsIndexResult,
  DEFAULT_SKILLS_INDEX_BATCH_SIZE,
  DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS,
  DEFAULT_SKILLS_INDEX_CHUNK_TOKENS,
  DEFAULT_SKILLS_INDEX_FILE,
  DEFAULT_SKILLS_INDEX_THRESHOLD,
  DEFAULT_SKILLS_RETRIEVAL_LIMIT,
  SkillsIndex,
} from './skills-index.ts';

export interface SkillsIndexCliOptions {
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
}

export interface SkillsIndexCliIo {
  log(message: string): void;
  error(message: string): void;
}

export const SKILLS_INDEX_CLI_HELP = `Build a semantic Agent Skills index

Usage: di-skills-index [options]

Options:
  --skills-dir <path>       SKILL.md tree; repeatable
  --skill-file <path>       Individual SKILL.md; repeatable
  --output <path>           JSONL output (default: ${DEFAULT_SKILLS_INDEX_FILE})
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

  for (let index = 0; index < args.length; index++) {
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
  };
}

export async function runSkillsIndexCli(
  args: readonly string[] = process.argv.slice(2),
  io: SkillsIndexCliIo = console,
  cwd = process.cwd(),
): Promise<BuildSkillsIndexResult | undefined> {
  const options = parseSkillsIndexCliArgs(args);
  if (options.help) {
    io.log(SKILLS_INDEX_CLI_HELP);
    return undefined;
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
  const result = await SkillsIndex.builder()
    .addSkillsDirectories(directories)
    .addSkillsFiles(files)
    .outputFile(resolve(cwd, expandUserPath(options.outputFile)))
    .threshold(options.threshold)
    .retrievalLimit(options.retrievalLimit)
    .batchSize(options.batchSize)
    .chunkTokens(options.chunkTokens)
    .chunkOverlapTokens(options.chunkOverlapTokens)
    .force(options.force)
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

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    const expectation = minimum === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new Error(`${flag} must be ${expectation}`);
  }
  return parsed;
}
