import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';
import { agentSkill, buildSkillsIndex, type SkillEmbedder } from '@di-framework/ai-utils';
import { parseBuildIndexOptions, preserveIndexBuildMeasurements } from './build-index.ts';
import { loadSkillCorpus, measureCatalog, selectCorpus } from './corpus.ts';
import {
  parseCliOptions,
  requireOpenAiApiKey,
  runAiSkillsScaleMain,
  runScaleExample,
  runSelectionTrial,
  selectionCases,
} from './main.ts';
import { retrievalCases } from './retrieval-cases.ts';
import {
  assertAwesomeCopilotBaseline,
  createBenchmarkEmbedder,
  parseRetrievalOptions,
  runRetrievalBenchmark,
  runRetrieveMain,
} from './retrieve.ts';

function writeSkill(root: string, directory: string, name = directory): void {
  const skillDirectory = join(root, directory);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Use this skill when handling ${name}.\n---\n# ${name}\nDo the work.\n`,
  );
}

describe('large skill corpus', () => {
  test('loads valid skills and reports incompatible third-party entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
    writeSkill(root, 'alpha');
    writeSkill(root, 'beta');
    writeSkill(root, 'wrong-folder', 'different-name');

    const corpus = loadSkillCorpus(root);
    expect(corpus.discoveredCount).toBe(3);
    expect(corpus.skills.map((skill) => skill.name)).toEqual(['alpha', 'beta']);
    expect(corpus.rejected).toHaveLength(1);
    expect(corpus.rejected[0]?.reason).toContain('must match the skill directory name');
  });

  test('measures the actual tool catalog and selects deterministic distractors', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
    for (const name of ['alpha', 'beta', 'gamma', 'target']) writeSkill(root, name);
    const skills = loadSkillCorpus(root).skills;

    const subset = selectCorpus(skills, 'target', 3, 7);
    expect(subset).toHaveLength(3);
    expect(subset.some((skill) => skill.name === 'target')).toBe(true);
    expect(selectCorpus(skills, 'target', 3, 7).map((skill) => skill.name)).toEqual(
      subset.map((skill) => skill.name),
    );
    expect(() => selectCorpus(skills, 'missing', 1)).toThrow(/Expected skill/);
    expect(() => selectCorpus(skills, 'target', 0)).toThrow(/positive integer/);
    const small = measureCatalog(subset.slice(0, 1));
    const large = measureCatalog(subset);
    expect(large.catalogCharacters).toBeGreaterThan(small.catalogCharacters);
    expect(large.instructionCharacters).toBeGreaterThan(small.instructionCharacters);
  });
});

test('selection trial records the Skill command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
  writeSkill(root, 'convert-pdf-to-md');
  writeSkill(root, 'other');
  const skills = loadSkillCorpus(root).skills;
  const model = new ScriptedChatModel([
    {
      respond: (prompt) => {
        expect(prompt.options?.toolCallbacks?.[0]?.toolDefinition.description).toContain(
          'convert-pdf-to-md',
        );
        return toolCallResponse([toolCall('c1', 'Skill', { command: 'convert-pdf-to-md' })]);
      },
    },
  ]);

  const result = await runSelectionTrial(model, skills, selectionCases[0]);
  expect(result.firstChoicePassed).toBe(true);
  expect(result.singleSelection).toBe(true);
  expect(result.selectedSkills).toEqual(['convert-pdf-to-md']);
  expect(result.providerPromptTokens).toBeUndefined();
});

test('selection trial reports model failures without executing skill content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
  writeSkill(root, 'convert-pdf-to-md');
  const model = new ScriptedChatModel([
    {
      respond: () => {
        throw new Error('provider unavailable');
      },
    },
  ]);

  const result = await runSelectionTrial(model, loadSkillCorpus(root).skills, selectionCases[0]);
  expect(result.firstChoicePassed).toBe(false);
  expect(result.error).toBe('provider unavailable');
});

test('CLI options default to stats and accept scale controls', () => {
  const defaults = parseCliOptions([]);
  expect(defaults.live).toBe(false);
  expect(defaults.sizes).toContain('all');

  const parsed = parseCliOptions([
    '--skills-dir',
    '/tmp/skills',
    '--sizes',
    '25,all',
    '--case',
    'postgres',
    '--trials',
    '2',
    '--seed',
    '9',
    '--model',
    'test-model',
    '--live',
  ]);
  expect(parsed.skillsDirectory).toBe('/tmp/skills');
  expect(parsed.sizes).toEqual([25, 'all']);
  expect(parsed.cases[0]?.id).toBe('postgres');
  expect(parsed.trials).toBe(2);
  expect(parsed.seed).toBe(9);
  expect(parsed.model).toBe('test-model');
  expect(parsed.live).toBe(true);
  expect(parseCliOptions(['--all-cases']).cases).toEqual(selectionCases);
  expect(() => parseCliOptions(['--case', 'missing'])).toThrow(/Unknown case/);
  expect(() => parseCliOptions(['--trials', '0'])).toThrow(/positive integer/);
  expect(() => parseCliOptions(['--seed', '1.5'])).toThrow(/positive integer/);
  expect(() => parseCliOptions(['--sizes', 'all,0'])).toThrow(/positive integer/);
  expect(() => parseCliOptions(['--model'])).toThrow(/requires a value/);
  expect(() => parseCliOptions(['--wat'])).toThrow(/Unknown option/);
});

test('scale runner prints stats, rejection summaries, and live trial results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
  writeSkill(root, 'convert-pdf-to-md');
  writeSkill(root, 'other');
  for (let index = 0; index < 6; index++) {
    writeSkill(root, `wrong-folder-${index}`, `wrong-name-${index}`);
  }

  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  await runScaleExample({
    skillsDirectory: root,
    sizes: [1, 'all'],
    cases: [selectionCases[0]],
    trials: 1,
    seed: 1,
    live: false,
    model: 'unused',
  });

  const model = new ScriptedChatModel([
    { respond: toolCallResponse([toolCall('c1', 'Skill', { command: 'convert-pdf-to-md' })]) },
    {
      respond: () => {
        throw 'temporary failure';
      },
    },
  ]);
  await runScaleExample(
    {
      skillsDirectory: root,
      sizes: [1, 'all'],
      cases: [selectionCases[0]],
      trials: 1,
      seed: 1,
      live: true,
      model: 'scripted',
    },
    model,
  );

  const output = log.mock.calls.flat().join('\n');
  expect(output).toContain('... 1 more rejected skills');
  expect(output).toContain('Stats only');
  expect(output).toContain('convert-pdf-to-md');
  expect(output).toContain('temporary failure');
  log.mockRestore();
});

test('live runner can construct the configured OpenAI model without making a request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-'));
  writeSkill(root, 'convert-pdf-to-md');
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const log = spyOn(console, 'log').mockImplementation(() => undefined);

  await runScaleExample({
    skillsDirectory: root,
    sizes: [1],
    cases: [],
    trials: 1,
    seed: 1,
    live: true,
    model: 'test-model',
  });

  expect(log).toHaveBeenCalled();
  log.mockRestore();
  if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousApiKey;
});

test('retrieval benchmark covers 30 uniquely labeled tasks', () => {
  expect(retrievalCases).toHaveLength(30);
  expect(new Set(retrievalCases.map((item) => item.id)).size).toBe(retrievalCases.length);
  expect(retrievalCases.slice(0, selectionCases.length)).toEqual([...selectionCases]);
});

test('retrieval reporter CLI accepts deterministic trial and output controls', async () => {
  expect(
    parseRetrievalOptions([
      '--index',
      '/tmp/index.jsonl',
      '--json',
      '/tmp/result.json',
      '--markdown',
      '/tmp/result.md',
      '--trials',
      '3',
      '--seed',
      '8',
      '--labels',
      'cases.json',
      '--corpus-id',
      'gitskills-1000',
      '--corpus-revision',
      'revision',
      '--min-score',
      '0.4',
    ]),
  ).toEqual({
    indexFile: '/tmp/index.jsonl',
    jsonFile: '/tmp/result.json',
    markdownFile: '/tmp/result.md',
    trials: 3,
    seed: 8,
    labelsFile: 'cases.json',
    corpusId: 'gitskills-1000',
    corpusRevision: 'revision',
    minScore: 0.4,
  });
  expect(() => parseRetrievalOptions(['--trials', '0'])).toThrow(/positive integer/);
  expect(() => parseRetrievalOptions(['--unknown'])).toThrow(/Unknown option/);
  expect(() => parseRetrievalOptions(['--min-score', 'nope'])).toThrow(/requires a number/);
  await expect(runRetrieveMain(false)).resolves.toBeUndefined();
});

test('retrieval benchmark ranks a deterministic index and writes both reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-benchmark-'));
  const indexFile = join(root, 'skills.jsonl');
  const jsonFile = join(root, 'results.json');
  const markdownFile = join(root, 'results.md');
  const names = retrievalCases.map((item) => item.expectedSkill);
  const embedder = deterministicRetrievalEmbedder(names);
  await buildSkillsIndex({
    skills: names.map((name) =>
      agentSkill({ name, description: `Routes ${name} requests.`, content: `# ${name}` }),
    ),
    outputFile: indexFile,
    threshold: 0,
    embedder,
  });
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const result = await runRetrievalBenchmark({
    indexFile,
    jsonFile,
    markdownFile,
    embedder,
    trials: 2,
    seed: 9,
  });
  expect(result?.metrics).toMatchObject({ recallAt1: 1, recallAt10: 1 });
  expect(JSON.parse(readFileSync(jsonFile, 'utf8')).trials).toHaveLength(60);
  expect(readFileSync(markdownFile, 'utf8')).toContain('Recall@1: 100.00%');

  const labelsFile = join(root, 'labels.json');
  const measurementsFile = `${indexFile}.measurements.json`;
  writeFileSync(
    labelsFile,
    JSON.stringify({
      cases: [
        {
          id: 'extended',
          prompt: retrievalCases[0]?.prompt,
          relevantSkills: [retrievalCases[0]?.expectedSkill],
          kind: 'hard',
        },
      ],
    }),
  );
  writeFileSync(
    measurementsFile,
    JSON.stringify({
      schemaVersion: 1,
      indexingMilliseconds: 25,
      artifactBytes: 50,
      peakMemoryBytes: 75,
    }),
  );
  const extended = await runRetrievalBenchmark({
    indexFile,
    jsonFile,
    markdownFile,
    labelsFile,
    corpusId: 'extended-fixture',
    corpusRevision: 'revision-1',
    minScore: 0.5,
    embedder,
  });
  expect(extended).toMatchObject({
    suite: 'extended-fixture semantic retrieval',
    corpus: { id: 'extended-fixture', revision: 'revision-1' },
    measurements: { indexingMilliseconds: 25, artifactBytes: 50 },
  });
  writeFileSync(labelsFile, JSON.stringify({ nope: [] }));
  await expect(runRetrievalBenchmark({ indexFile, labelsFile, embedder })).rejects.toThrow(
    /cases array/,
  );
  log.mockRestore();
});

test('retrieval benchmark rejects a missing index and skips metadata-only indexes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-empty-'));
  await expect(runRetrievalBenchmark(join(root, 'missing.jsonl'))).rejects.toThrow(/missing/);
  const indexFile = join(root, 'small.jsonl');
  await buildSkillsIndex({
    skills: [agentSkill({ name: 'one', description: 'One skill.', content: '# One' })],
    outputFile: indexFile,
  });
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  await expect(runRetrievalBenchmark(indexFile)).resolves.toBeUndefined();
  await expect(runRetrieveMain(true, ['--index', indexFile])).resolves.toBeUndefined();
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

function deterministicRetrievalEmbedder(names: readonly string[]): SkillEmbedder {
  const vector = (index: number) => {
    const value = new Float32Array(names.length);
    value[index] = 1;
    return value;
  };
  return {
    id: 'deterministic-retrieval-fixture',
    model: 'fixture',
    revision: '1',
    split: async (text) => [text],
    embed: async (texts, options) =>
      texts.map((text) => {
        const index =
          options?.purpose === 'query'
            ? retrievalCases.findIndex((item) => item.prompt === text)
            : names.findIndex((name) => text.includes(name));
        if (index < 0) throw new Error(`Unknown deterministic retrieval text: ${text}`);
        return vector(index);
      }),
  };
}
test('index CLI accepts extended corpus paths and baseline thresholds are mandatory', () => {
  expect(
    parseBuildIndexOptions([
      '--skills-dir',
      '.cache/gitskills-1000',
      '--output',
      '.cache/gitskills-1000.jsonl',
    ]),
  ).toEqual({
    skillsDirectory: '.cache/gitskills-1000',
    outputFile: '.cache/gitskills-1000.jsonl',
  });
  expect(() => parseBuildIndexOptions(['--wat'])).toThrow(/Unknown option/);
  const prior = {
    schemaVersion: 1 as const,
    indexingMilliseconds: 500,
    artifactBytes: 100,
    peakMemoryBytes: 1_000,
  };
  const current = {
    schemaVersion: 1 as const,
    indexingMilliseconds: 5,
    artifactBytes: 100,
    peakMemoryBytes: 1_100,
  };
  expect(preserveIndexBuildMeasurements(current, prior, true)).toEqual({
    ...current,
    indexingMilliseconds: 500,
  });
  expect(preserveIndexBuildMeasurements(current, prior, false)).toEqual(current);
  const result = {
    trialsPerCase: 1,
    metrics: { positiveTrials: 30, recallAt1: 29 / 30, recallAt10: 1 },
  };
  expect(() => assertAwesomeCopilotBaseline(result as never)).not.toThrow();
  expect(() =>
    assertAwesomeCopilotBaseline({
      ...result,
      metrics: { ...result.metrics, recallAt1: 28 / 30 },
    } as never),
  ).toThrow(/regressed/);
  expect(() =>
    assertAwesomeCopilotBaseline({
      ...result,
      metrics: { ...result.metrics, positiveTrials: 29 },
    } as never),
  ).toThrow(/retain all 30/);
  const defaultEmbedder = createBenchmarkEmbedder({ model: 'fixture-model', revision: 'rev' });
  expect(defaultEmbedder).toMatchObject({ model: 'fixture-model', revision: 'rev' });
});
test('live key resolves from the environment or a non-executed secrets file', () => {
  expect(requireOpenAiApiKey({ OPENAI_API_KEY: ' direct ' }, '/')).toBe('direct');
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-key-'));
  const nested = join(root, 'one', 'two');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, '.env.secrets'), 'OTHER=x\nOPENAI_API_KEY="from-file"\n');
  expect(requireOpenAiApiKey({}, nested)).toBe('from-file');
  const missingKeyRoot = mkdtempSync(join(tmpdir(), 'ai-skills-scale-no-key-'));
  writeFileSync(join(missingKeyRoot, '.env.secrets'), 'OTHER=x\n');
  expect(() => requireOpenAiApiKey({}, missingKeyRoot)).toThrow(/OPENAI_API_KEY/);
  expect(() => requireOpenAiApiKey({}, '/')).toThrow(/OPENAI_API_KEY/);
});

test('main gate is a no-op when imported', async () => {
  await expect(runAiSkillsScaleMain(false)).resolves.toBeUndefined();
});

test('main gate forwards explicit CLI arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-main-'));
  writeSkill(root, 'alpha');
  const log = spyOn(console, 'log').mockImplementation(() => undefined);

  await runAiSkillsScaleMain(true, ['--skills-dir', root, '--sizes', '1']);

  expect(log).toHaveBeenCalled();
  log.mockRestore();
});
