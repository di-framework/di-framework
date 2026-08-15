import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';
import { loadSkillCorpus, measureCatalog, selectCorpus } from './corpus.ts';
import {
  parseCliOptions,
  requireOpenAiApiKey,
  runAiSkillsScaleMain,
  runSelectionTrial,
  selectionCases,
} from './main.ts';
import { retrievalCases } from './retrieval-cases.ts';

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
  expect(() => parseCliOptions(['--case', 'missing'])).toThrow(/Unknown case/);
});

test('retrieval benchmark covers 30 uniquely labeled tasks', () => {
  expect(retrievalCases).toHaveLength(30);
  expect(new Set(retrievalCases.map((item) => item.id)).size).toBe(retrievalCases.length);
  expect(retrievalCases.slice(0, selectionCases.length)).toEqual([...selectionCases]);
});

test('live key resolves from the environment or a non-executed secrets file', () => {
  expect(requireOpenAiApiKey({ OPENAI_API_KEY: ' direct ' }, '/')).toBe('direct');
  const root = mkdtempSync(join(tmpdir(), 'ai-skills-scale-key-'));
  writeFileSync(join(root, '.env.secrets'), 'OTHER=x\nOPENAI_API_KEY="from-file"\n');
  expect(requireOpenAiApiKey({}, root)).toBe('from-file');
  expect(() => requireOpenAiApiKey({}, '/')).toThrow(/OPENAI_API_KEY/);
});

test('main gate is a no-op when imported', async () => {
  await expect(runAiSkillsScaleMain(false)).resolves.toBeUndefined();
});
