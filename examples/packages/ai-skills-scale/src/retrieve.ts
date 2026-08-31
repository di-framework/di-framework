import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadSkillsIndex,
  rankSkillsIndex,
  type SkillEmbedder,
  type SkillsIndexMetadata,
  TransformersJsSkillEmbedder,
} from '@di-framework/ai-utils';
import { defaultIndexFile, exampleRoot } from './corpus.ts';
import {
  formatEvaluationJson,
  formatEvaluationMarkdown,
  type RetrievalEvaluationCase,
  type RetrievalEvaluationResult,
  runRetrievalEvaluation,
} from './evaluation.ts';
import { type IndexBuildMeasurements, indexMeasurementsFile } from './index-measurements.ts';
import { retrievalCases } from './retrieval-cases.ts';

export const AWESOME_COPILOT_BASELINE_REVISION = 'a80885b76044550770f60f360f8a0e5ae3524a31';
export const defaultJsonResultsFile = join(exampleRoot, '.cache', 'retrieval-results.json');
export const defaultMarkdownResultsFile = join(exampleRoot, '.cache', 'retrieval-results.md');

export interface RetrievalBenchmarkOptions {
  readonly indexFile?: string;
  readonly jsonFile?: string;
  readonly markdownFile?: string;
  readonly trials?: number;
  readonly seed?: number;
  readonly embedder?: SkillEmbedder;
  readonly labelsFile?: string;
  readonly corpusId?: string;
  readonly corpusRevision?: string;
  readonly minScore?: number;
}

export async function runRetrievalBenchmark(
  options: RetrievalBenchmarkOptions | string = {},
): Promise<RetrievalEvaluationResult | undefined> {
  const resolved = typeof options === 'string' ? { indexFile: options } : options;
  const indexFile = resolved.indexFile ?? defaultIndexFile;
  if (!existsSync(indexFile)) {
    throw new Error('Skills index is missing. Run `bun run index` first.');
  }
  const index = loadSkillsIndex(indexFile);
  if (!index.metadata.indexed) {
    console.log(
      `Catalog has ${index.metadata.skillCount} skills, at or below threshold ${index.metadata.threshold}; semantic retrieval is disabled.`,
    );
    return undefined;
  }

  const embedder = resolved.embedder ?? createBenchmarkEmbedder(index.metadata);
  const evaluationCases = resolved.labelsFile
    ? await loadEvaluationCases(resolved.labelsFile)
    : retrievalCases.map((item) => ({
        id: item.id,
        prompt: item.prompt,
        relevantSkills: [item.expectedSkill],
        kind: 'unique' as const,
      }));
  const recordedMeasurements = await loadIndexMeasurements(indexFile);
  const result = await runRetrievalEvaluation({
    suite: resolved.labelsFile
      ? `${resolved.corpusId ?? 'extended'} semantic retrieval`
      : 'awesome-copilot semantic retrieval baseline',
    corpus: {
      id: resolved.corpusId ?? 'github/awesome-copilot',
      revision: resolved.corpusRevision ?? AWESOME_COPILOT_BASELINE_REVISION,
      skillCount: index.metadata.skillCount,
    },
    cases: evaluationCases,
    trials: resolved.trials,
    seed: resolved.seed,
    measurements: recordedMeasurements ?? { artifactBytes: statSync(indexFile).size },
    retrieve: async (evaluationCase) => {
      const embeddingStarted = performance.now();
      const [query] = await embedder.embed([evaluationCase.prompt], { purpose: 'query' });
      const embeddingFinished = performance.now();
      if (!query) throw new Error('Skill embedder did not return a query vector');
      const searchStarted = performance.now();
      const candidates = rankSkillsIndex(index, query, {
        limit: index.entries.length,
        minScore: resolved.minScore,
      }).map((match) => ({ name: match.name, score: match.score }));
      const searchFinished = performance.now();
      return {
        candidates,
        queryEmbeddingMilliseconds: embeddingFinished - embeddingStarted,
        searchMilliseconds: searchFinished - searchStarted,
      };
    },
  });

  writeReport(resolved.jsonFile ?? defaultJsonResultsFile, formatEvaluationJson(result));
  writeReport(
    resolved.markdownFile ?? defaultMarkdownResultsFile,
    formatEvaluationMarkdown(result),
  );
  console.log(formatEvaluationMarkdown(result));
  if (!resolved.labelsFile) assertAwesomeCopilotBaseline(result);
  return result;
}

export function createBenchmarkEmbedder(
  metadata: Pick<SkillsIndexMetadata, 'model' | 'revision'>,
): SkillEmbedder {
  return new TransformersJsSkillEmbedder({
    model: metadata.model,
    revision: metadata.revision,
  });
}

export function assertAwesomeCopilotBaseline(result: RetrievalEvaluationResult): void {
  if (result.metrics.positiveTrials !== 30 * result.trialsPerCase) {
    throw new Error('The awesome-copilot baseline must retain all 30 labeled cases');
  }
  if (result.metrics.recallAt1 < 29 / 30 || result.metrics.recallAt10 < 1) {
    throw new Error(
      `awesome-copilot baseline regressed: recall@1 ${result.metrics.recallAt1}, recall@10 ${result.metrics.recallAt10}`,
    );
  }
}

async function loadEvaluationCases(file: string): Promise<readonly RetrievalEvaluationCase[]> {
  const value = JSON.parse(await Bun.file(file).text()) as { cases?: unknown };
  if (!Array.isArray(value.cases)) throw new Error('Evaluation labels file requires a cases array');
  return value.cases as RetrievalEvaluationCase[];
}

async function loadIndexMeasurements(file: string): Promise<IndexBuildMeasurements | undefined> {
  const measurements = Bun.file(indexMeasurementsFile(file));
  if (!(await measurements.exists())) return undefined;
  const value = JSON.parse(await measurements.text()) as IndexBuildMeasurements;
  return value.schemaVersion === 1 ? value : undefined;
}

function writeReport(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

export async function runRetrieveMain(
  isMain = import.meta.main,
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (!isMain) return;
  await runRetrievalBenchmark(parseRetrievalOptions(args));
}

export function parseRetrievalOptions(args: readonly string[]): RetrievalBenchmarkOptions {
  const options: {
    indexFile?: string;
    jsonFile?: string;
    markdownFile?: string;
    trials?: number;
    seed?: number;
    labelsFile?: string;
    corpusId?: string;
    corpusRevision?: string;
    minScore?: number;
  } = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case '--index':
        options.indexFile = value();
        break;
      case '--json':
        options.jsonFile = value();
        break;
      case '--markdown':
        options.markdownFile = value();
        break;
      case '--trials':
        options.trials = positiveInteger(value(), flag);
        break;
      case '--seed':
        options.seed = positiveInteger(value(), flag);
        break;
      case '--labels':
        options.labelsFile = value();
        break;
      case '--corpus-id':
        options.corpusId = value();
        break;
      case '--corpus-revision':
        options.corpusRevision = value();
        break;
      case '--min-score': {
        const parsed = Number(value());
        if (!Number.isFinite(parsed)) throw new Error('--min-score requires a number');
        options.minScore = parsed;
        break;
      }
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

await runRetrieveMain();
