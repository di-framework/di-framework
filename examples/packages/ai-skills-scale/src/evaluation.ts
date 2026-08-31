export type RetrievalCaseKind =
  | 'unique'
  | 'hard'
  | 'multi-skill'
  | 'ambiguous'
  | 'no-skill'
  | 'typo'
  | 'multilingual'
  | 'long-context'
  | 'adversarial';

export interface RetrievalEvaluationCase {
  readonly id: string;
  readonly prompt: string;
  readonly relevantSkills: readonly string[];
  readonly kind: RetrievalCaseKind;
  readonly language?: string;
  readonly notes?: string;
}

export interface RetrievalCandidate {
  readonly name: string;
  readonly score: number;
}

export interface RetrievalTrialOutput {
  readonly candidates: readonly RetrievalCandidate[];
  readonly queryEmbeddingMilliseconds?: number;
  readonly searchMilliseconds?: number;
}

export interface RetrievalTrialContext {
  readonly trial: number;
  readonly seed: number;
}

export interface RetrievalEvaluationMeasurements {
  readonly indexingMilliseconds?: number;
  readonly artifactBytes?: number;
  readonly peakMemoryBytes?: number;
}

export interface RetrievalEvaluationOptions {
  readonly suite: string;
  readonly corpus: {
    readonly id: string;
    readonly revision: string;
    readonly skillCount: number;
  };
  readonly cases: readonly RetrievalEvaluationCase[];
  readonly retrieve: (
    evaluationCase: RetrievalEvaluationCase,
    context: RetrievalTrialContext,
  ) => RetrievalTrialOutput | Promise<RetrievalTrialOutput>;
  readonly trials?: number;
  readonly seed?: number;
  readonly measurements?: RetrievalEvaluationMeasurements;
  readonly now?: () => number;
  readonly memoryUsage?: () => number;
}

export interface RetrievalTrialResult {
  readonly caseId: string;
  readonly kind: RetrievalCaseKind;
  readonly trial: number;
  readonly seed: number;
  readonly relevantSkills: readonly string[];
  readonly candidates: readonly RetrievalCandidate[];
  readonly firstRelevantRank: number | null;
  readonly abstained: boolean;
  readonly queryEmbeddingMilliseconds: number | null;
  readonly searchMilliseconds: number | null;
  readonly totalMilliseconds: number;
  readonly memoryDeltaBytes: number;
}

export interface LatencySummary {
  readonly samples: number;
  readonly meanMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface RetrievalEvaluationMetrics {
  readonly positiveTrials: number;
  readonly noSkillTrials: number;
  readonly recallAt1: number;
  readonly recallAt10: number;
  readonly meanReciprocalRank: number;
  readonly abstentionRate: number;
  readonly noSkillFalsePositiveRate: number;
  readonly queryEmbeddingLatency: LatencySummary;
  readonly searchLatency: LatencySummary;
  readonly totalLatency: LatencySummary;
}

export interface RetrievalEvaluationResult {
  readonly schemaVersion: 1;
  readonly suite: string;
  readonly corpus: RetrievalEvaluationOptions['corpus'];
  readonly trialsPerCase: number;
  readonly seed: number;
  readonly caseCount: number;
  readonly measurements: Required<RetrievalEvaluationMeasurements>;
  readonly metrics: RetrievalEvaluationMetrics;
  readonly trials: readonly RetrievalTrialResult[];
}

/**
 * Execute cases in a stable order with stable per-trial seeds. Retrieval may be
 * nondeterministic, but the schedule and resulting metric calculation are not.
 */
export async function runRetrievalEvaluation(
  options: RetrievalEvaluationOptions,
): Promise<RetrievalEvaluationResult> {
  validateEvaluationOptions(options);
  const trialsPerCase = options.trials ?? 1;
  const seed = options.seed ?? 1;
  const now = options.now ?? (() => performance.now());
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage.rss());
  const results: RetrievalTrialResult[] = [];
  let observedPeakMemory = memoryUsage();

  for (const evaluationCase of options.cases) {
    for (let trial = 1; trial <= trialsPerCase; trial++) {
      const trialSeed = mixSeed(seed, evaluationCase.id, trial);
      const memoryBefore = memoryUsage();
      const started = now();
      const memorySampler = setInterval(() => {
        observedPeakMemory = Math.max(observedPeakMemory, memoryUsage());
      }, 10);
      memorySampler.unref();
      let output: RetrievalTrialOutput;
      try {
        output = await options.retrieve(evaluationCase, { trial, seed: trialSeed });
      } finally {
        clearInterval(memorySampler);
      }
      const finished = now();
      const memoryAfter = memoryUsage();
      observedPeakMemory = Math.max(observedPeakMemory, memoryBefore, memoryAfter);
      const candidates = normalizeCandidates(output.candidates);
      const relevant = new Set(evaluationCase.relevantSkills);
      const firstRelevant = candidates.findIndex((candidate) => relevant.has(candidate.name));

      results.push({
        caseId: evaluationCase.id,
        kind: evaluationCase.kind,
        trial,
        seed: trialSeed,
        relevantSkills: [...evaluationCase.relevantSkills],
        candidates,
        firstRelevantRank: firstRelevant < 0 ? null : firstRelevant + 1,
        abstained: candidates.length === 0,
        queryEmbeddingMilliseconds: finiteMeasurement(output.queryEmbeddingMilliseconds),
        searchMilliseconds: finiteMeasurement(output.searchMilliseconds),
        totalMilliseconds: Math.max(0, finished - started),
        memoryDeltaBytes: Math.max(0, memoryAfter - memoryBefore),
      });
    }
  }

  return {
    schemaVersion: 1,
    suite: options.suite,
    corpus: options.corpus,
    trialsPerCase,
    seed,
    caseCount: options.cases.length,
    measurements: {
      indexingMilliseconds: options.measurements?.indexingMilliseconds ?? 0,
      artifactBytes: options.measurements?.artifactBytes ?? 0,
      peakMemoryBytes: Math.max(options.measurements?.peakMemoryBytes ?? 0, observedPeakMemory),
    },
    metrics: calculateMetrics(results),
    trials: results,
  };
}

export function calculateMetrics(
  trials: readonly RetrievalTrialResult[],
): RetrievalEvaluationMetrics {
  const positive = trials.filter((trial) => trial.relevantSkills.length > 0);
  const noSkill = trials.filter((trial) => trial.relevantSkills.length === 0);
  const recalled = (limit: number) =>
    positive.filter((trial) => trial.firstRelevantRank !== null && trial.firstRelevantRank <= limit)
      .length;
  const reciprocalRank = positive.reduce(
    (total, trial) => total + (trial.firstRelevantRank === null ? 0 : 1 / trial.firstRelevantRank),
    0,
  );
  const noSkillAbstentions = noSkill.filter((trial) => trial.abstained).length;

  return {
    positiveTrials: positive.length,
    noSkillTrials: noSkill.length,
    recallAt1: ratio(recalled(1), positive.length),
    recallAt10: ratio(recalled(10), positive.length),
    meanReciprocalRank: ratio(reciprocalRank, positive.length),
    abstentionRate: ratio(noSkillAbstentions, noSkill.length),
    noSkillFalsePositiveRate: ratio(noSkill.length - noSkillAbstentions, noSkill.length),
    queryEmbeddingLatency: summarizeLatency(
      trials.flatMap((trial) =>
        trial.queryEmbeddingMilliseconds === null ? [] : [trial.queryEmbeddingMilliseconds],
      ),
    ),
    searchLatency: summarizeLatency(
      trials.flatMap((trial) =>
        trial.searchMilliseconds === null ? [] : [trial.searchMilliseconds],
      ),
    ),
    totalLatency: summarizeLatency(trials.map((trial) => trial.totalMilliseconds)),
  };
}

export function formatEvaluationJson(result: RetrievalEvaluationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function formatEvaluationMarkdown(result: RetrievalEvaluationResult): string {
  const { metrics, measurements } = result;
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const latency = (value: LatencySummary) =>
    `${value.meanMilliseconds.toFixed(2)} ms mean / ${value.p95Milliseconds.toFixed(2)} ms p95`;
  const rows = result.trials.map((trial) => {
    const rank = trial.firstRelevantRank ?? '—';
    const top = trial.candidates[0]?.name ?? '(abstained)';
    return `| ${escapeCell(trial.caseId)} | ${trial.trial} | ${trial.kind} | ${rank} | ${escapeCell(top)} | ${trial.totalMilliseconds.toFixed(2)} |`;
  });

  return [
    `# Retrieval evaluation: ${result.suite}`,
    '',
    '> These are measured results for the named pinned corpus and run; they are not general quality claims.',
    '',
    `- Corpus: \`${result.corpus.id}\` at \`${result.corpus.revision}\` (${result.corpus.skillCount} skills)`,
    `- Cases: ${result.caseCount}; trials per case: ${result.trialsPerCase}; seed: ${result.seed}`,
    `- Recall@1: ${percent(metrics.recallAt1)} (${metrics.positiveTrials} positive trials)`,
    `- Recall@10: ${percent(metrics.recallAt10)}`,
    `- Mean reciprocal rank: ${metrics.meanReciprocalRank.toFixed(4)}`,
    `- No-skill abstention: ${percent(metrics.abstentionRate)}; false positives: ${percent(metrics.noSkillFalsePositiveRate)} (${metrics.noSkillTrials} trials)`,
    `- Query embedding latency: ${latency(metrics.queryEmbeddingLatency)}`,
    `- Search latency: ${latency(metrics.searchLatency)}`,
    `- End-to-end retrieval latency: ${latency(metrics.totalLatency)}`,
    `- Indexing time: ${measurements.indexingMilliseconds.toFixed(2)} ms`,
    `- Artifact size: ${measurements.artifactBytes} bytes; peak RSS: ${measurements.peakMemoryBytes} bytes`,
    '',
    '| Case | Trial | Kind | First relevant rank | Top candidate | Total ms |',
    '| --- | ---: | --- | ---: | --- | ---: |',
    ...rows,
    '',
  ].join('\n');
}

function validateEvaluationOptions(options: RetrievalEvaluationOptions): void {
  if (!options.suite.trim()) throw new Error('Evaluation suite must have a name');
  if (!options.corpus.id.trim() || !options.corpus.revision.trim()) {
    throw new Error('Evaluation corpus id and pinned revision are required');
  }
  if (!Number.isInteger(options.corpus.skillCount) || options.corpus.skillCount < 1) {
    throw new Error('Evaluation corpus skillCount must be a positive integer');
  }
  if (!Number.isInteger(options.trials ?? 1) || (options.trials ?? 1) < 1) {
    throw new Error('Evaluation trials must be a positive integer');
  }
  const ids = new Set<string>();
  for (const evaluationCase of options.cases) {
    if (!evaluationCase.id.trim() || !evaluationCase.prompt.trim()) {
      throw new Error('Evaluation cases require non-empty ids and prompts');
    }
    if (ids.has(evaluationCase.id))
      throw new Error(`Duplicate evaluation case: ${evaluationCase.id}`);
    ids.add(evaluationCase.id);
    if (new Set(evaluationCase.relevantSkills).size !== evaluationCase.relevantSkills.length) {
      throw new Error(`Evaluation case ${evaluationCase.id} repeats a relevant skill`);
    }
    if (evaluationCase.kind === 'no-skill' && evaluationCase.relevantSkills.length > 0) {
      throw new Error(`No-skill case ${evaluationCase.id} cannot have relevant skills`);
    }
    if (evaluationCase.kind !== 'no-skill' && evaluationCase.relevantSkills.length === 0) {
      throw new Error(`Positive case ${evaluationCase.id} requires a relevant skill`);
    }
  }
}

function normalizeCandidates(
  candidates: readonly RetrievalCandidate[],
): readonly RetrievalCandidate[] {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    if (!candidate.name.trim()) throw new Error('Retrieval candidate names cannot be empty');
    if (!Number.isFinite(candidate.score))
      throw new Error('Retrieval candidate scores must be finite');
    if (seen.has(candidate.name))
      throw new Error(`Duplicate retrieval candidate: ${candidate.name}`);
    seen.add(candidate.name);
    return { name: candidate.name, score: candidate.score };
  });
}

function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { samples: 0, meanMilliseconds: 0, p50Milliseconds: 0, p95Milliseconds: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    meanMilliseconds: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50Milliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function finiteMeasurement(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Latency measurements must be finite and non-negative');
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mixSeed(seed: number, id: string, trial: number): number {
  let hash = (seed ^ trial) >>> 0;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/g, ' ');
}
