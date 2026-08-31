import { describe, expect, test } from 'bun:test';
import {
  calculateMetrics,
  formatEvaluationJson,
  formatEvaluationMarkdown,
  type RetrievalTrialResult,
  runRetrievalEvaluation,
} from './evaluation.ts';

describe('retrieval evaluation harness', () => {
  test('runs a deterministic repeated schedule and calculates quality and resource metrics', async () => {
    let clock = 0;
    const seeds: number[] = [];
    const result = await runRetrievalEvaluation({
      suite: 'ci',
      corpus: { id: 'fixture', revision: 'abc123', skillCount: 3 },
      cases: [
        { id: 'unique', prompt: 'alpha', relevantSkills: ['alpha'], kind: 'unique' },
        { id: 'multi', prompt: 'both', relevantSkills: ['alpha', 'beta'], kind: 'multi-skill' },
        { id: 'none', prompt: 'weather', relevantSkills: [], kind: 'no-skill' },
      ],
      trials: 2,
      seed: 42,
      measurements: { indexingMilliseconds: 12, artifactBytes: 99, peakMemoryBytes: 500 },
      now: () => (clock += 2),
      memoryUsage: () => 100,
      retrieve: (evaluationCase, context) => {
        seeds.push(context.seed);
        if (evaluationCase.id === 'unique') {
          return {
            candidates: [
              { name: 'noise', score: 0.8 },
              { name: 'alpha', score: 0.7 },
            ],
            queryEmbeddingMilliseconds: 1,
            searchMilliseconds: 0.5,
          };
        }
        if (evaluationCase.id === 'multi') return { candidates: [{ name: 'beta', score: 0.9 }] };
        return context.trial === 1
          ? { candidates: [] }
          : { candidates: [{ name: 'noise', score: 0.1 }] };
      },
    });

    expect(result.trials).toHaveLength(6);
    const firstSchedule = seeds.slice(0, 2);
    expect(firstSchedule).toHaveLength(2);
    expect(new Set(seeds).size).toBe(6);
    expect(result.metrics).toMatchObject({
      positiveTrials: 4,
      noSkillTrials: 2,
      recallAt1: 0.5,
      recallAt10: 1,
      meanReciprocalRank: 0.75,
      abstentionRate: 0.5,
      noSkillFalsePositiveRate: 0.5,
    });
    expect(result.metrics.queryEmbeddingLatency).toEqual({
      samples: 2,
      meanMilliseconds: 1,
      p50Milliseconds: 1,
      p95Milliseconds: 1,
    });
    expect(result.measurements).toEqual({
      indexingMilliseconds: 12,
      artifactBytes: 99,
      peakMemoryBytes: 500,
    });

    const rerun = await runRetrievalEvaluation({
      suite: 'ci',
      corpus: { id: 'fixture', revision: 'abc123', skillCount: 3 },
      cases: [{ id: 'unique', prompt: 'alpha', relevantSkills: ['alpha'], kind: 'unique' }],
      trials: 2,
      seed: 42,
      now: () => 0,
      memoryUsage: () => 0,
      retrieve: (_case, context) => ({ candidates: [{ name: String(context.seed), score: 1 }] }),
    });
    expect(rerun.trials.map((trial) => trial.seed)).toEqual(firstSchedule);
  });

  test('emits stable JSON and a measured-results Markdown report', async () => {
    const result = await runRetrievalEvaluation({
      suite: 'report | fixture',
      corpus: { id: 'fixture', revision: 'abc123', skillCount: 1 },
      cases: [{ id: 'one | row', prompt: 'alpha', relevantSkills: ['alpha'], kind: 'unique' }],
      now: () => 0,
      memoryUsage: () => 0,
      retrieve: () => ({ candidates: [{ name: 'alpha', score: 1 }] }),
    });
    expect(JSON.parse(formatEvaluationJson(result))).toEqual(result);
    const markdown = formatEvaluationMarkdown(result);
    expect(markdown).toContain('measured results');
    expect(markdown).toContain('Recall@1: 100.00%');
    expect(markdown).toContain('one \\| row');
  });

  test('samples peak memory while asynchronous retrieval is in flight', async () => {
    let memory = 100;
    const result = await runRetrievalEvaluation({
      suite: 'memory',
      corpus: { id: 'fixture', revision: 'abc123', skillCount: 1 },
      cases: [{ id: 'one', prompt: 'alpha', relevantSkills: ['alpha'], kind: 'unique' }],
      now: () => 0,
      memoryUsage: () => (memory += 10),
      retrieve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { candidates: [{ name: 'alpha', score: 1 }] };
      },
    });
    expect(result.measurements.peakMemoryBytes).toBeGreaterThan(120);
  });

  test('uses safe zero-valued metrics when a class has no trials', () => {
    const positive: RetrievalTrialResult = {
      caseId: 'one',
      kind: 'unique',
      trial: 1,
      seed: 1,
      relevantSkills: ['alpha'],
      candidates: [],
      firstRelevantRank: null,
      abstained: true,
      queryEmbeddingMilliseconds: null,
      searchMilliseconds: null,
      totalMilliseconds: 0,
      memoryDeltaBytes: 0,
    };
    expect(calculateMetrics([positive])).toMatchObject({
      recallAt1: 0,
      abstentionRate: 0,
      noSkillFalsePositiveRate: 0,
    });
    expect(calculateMetrics([]).totalLatency.samples).toBe(0);
  });

  test('rejects malformed suites, cases, measurements, and candidates', async () => {
    const base = {
      suite: 'ci',
      corpus: { id: 'fixture', revision: 'abc', skillCount: 1 },
      cases: [{ id: 'one', prompt: 'go', relevantSkills: ['alpha'], kind: 'unique' as const }],
      retrieve: () => ({ candidates: [] }),
    };
    await expect(runRetrievalEvaluation({ ...base, trials: 0 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      runRetrievalEvaluation({ ...base, corpus: { ...base.corpus, revision: '' } }),
    ).rejects.toThrow(/pinned revision/);
    await expect(
      runRetrievalEvaluation({ ...base, corpus: { ...base.corpus, skillCount: 0 } }),
    ).rejects.toThrow(/skillCount/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        cases: [{ id: '', prompt: '', relevantSkills: ['alpha'], kind: 'unique' }],
      }),
    ).rejects.toThrow(/non-empty ids/);
    await expect(
      runRetrievalEvaluation({ ...base, cases: [...base.cases, ...base.cases] }),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        cases: [
          {
            id: 'repeat',
            prompt: 'go',
            relevantSkills: ['alpha', 'alpha'],
            kind: 'unique',
          },
        ],
      }),
    ).rejects.toThrow(/repeats a relevant skill/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        cases: [{ id: 'none', prompt: 'go', relevantSkills: ['alpha'], kind: 'no-skill' }],
      }),
    ).rejects.toThrow(/cannot have relevant/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        cases: [{ id: 'positive', prompt: 'go', relevantSkills: [], kind: 'unique' }],
      }),
    ).rejects.toThrow(/requires a relevant skill/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        retrieve: () => ({ candidates: [{ name: 'alpha', score: Number.NaN }] }),
      }),
    ).rejects.toThrow(/finite/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        retrieve: () => ({
          candidates: [
            { name: 'alpha', score: 1 },
            { name: 'alpha', score: 0.5 },
          ],
        }),
      }),
    ).rejects.toThrow(/Duplicate retrieval/);
    await expect(
      runRetrievalEvaluation({
        ...base,
        retrieve: () => ({ candidates: [], searchMilliseconds: -1 }),
      }),
    ).rejects.toThrow(/non-negative/);
  });
});
