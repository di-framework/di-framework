import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ChatAgent, ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';
import {
  createLiveReviewAgent,
  createReviewAgent,
  exampleRoot,
  exampleSkillsToolbox,
  loadEnvSecrets,
  requireOpenAiApiKey,
  runAiSkillsMain,
  runLiveExample,
  sampleUserPath,
} from './main.ts';

const checklist = join(
  exampleRoot,
  '.claude',
  'skills',
  'code-reviewer',
  'references',
  'checklist.md',
);

loadEnvSecrets();
const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());

test('toolbox loads the committed example skill', () => {
  const box = exampleSkillsToolbox();
  expect(box.skills.map((s) => s.name)).toEqual(['code-reviewer']);
  expect(box.tools.map((t) => t.toolDefinition.name)).toEqual([
    'Skill',
    'Read',
    'ListDirectory',
    'Glob',
    'Grep',
    'TodoWrite',
  ]);
});

test('opt-in shell adds Bash after the default file tools', () => {
  const box = exampleSkillsToolbox({ shell: true });
  expect(box.tools.map((t) => t.toolDefinition.name)).toContain('Bash');
});

test('agent loads the skill then the checklist via Read', async () => {
  const model = new ScriptedChatModel([
    {
      respond: toolCallResponse([toolCall('c1', 'Skill', { command: 'code-reviewer' })]),
    },
    {
      respond: toolCallResponse([toolCall('c2', 'Read', { filePath: checklist })]),
    },
    {
      respond: (prompt) => {
        const blob = JSON.stringify(prompt.messages);
        expect(blob).toContain('Load `references/checklist.md`');
        expect(blob).toContain('Flag possible null');
        return 'Looks good: watch for nulls.';
      },
    },
  ]);

  const agent = createReviewAgent(model);
  expect(agent).toBeInstanceOf(ChatAgent);
  const { content } = await agent.chat('Review src/main.ts');
  expect(content).toBe('Looks good: watch for nulls.');
});

test('runLiveExample records Skill then Read with a scripted model', async () => {
  const model = new ScriptedChatModel([
    {
      respond: toolCallResponse([toolCall('c1', 'Skill', { command: 'code-reviewer' })]),
    },
    {
      respond: toolCallResponse([toolCall('c2', 'Read', { filePath: sampleUserPath })]),
    },
    {
      respond: toolCallResponse([toolCall('c3', 'Read', { filePath: checklist })]),
    },
    {
      respond: 'displayName dereferences user and name without a guard.',
    },
  ]);

  const result = await runLiveExample(model);
  expect(result.usedTools).toEqual(['Skill', 'Read', 'Read']);
  expect(result.content).toContain('displayName');
});

test('requireOpenAiApiKey fails when the env var is missing', () => {
  expect(() => requireOpenAiApiKey({})).toThrow(/OPENAI_API_KEY is not set/);
});

test('loadEnvSecrets finds the repo .env.secrets when present', () => {
  const loaded = loadEnvSecrets();
  if (loaded) {
    expect(loaded.endsWith('.env.secrets')).toBe(true);
    expect(hasOpenAiKey).toBe(true);
  }
});

test('CLI main gate is a no-op when isMain is false', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runAiSkillsMain(false);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test.skipIf(!hasOpenAiKey)(
  'live OpenAI review uses Skill + Read and flags the sample null access',
  async () => {
    expect(createLiveReviewAgent()).toBeInstanceOf(ChatAgent);
    const result = await runLiveExample();
    expect(result.usedTools).toContain('Skill');
    expect(result.usedTools).toContain('Read');
    expect(result.content.length).toBeGreaterThan(20);
    expect(result.content.toLowerCase()).toMatch(/null|undefined|optional/);
  },
  120_000,
);
