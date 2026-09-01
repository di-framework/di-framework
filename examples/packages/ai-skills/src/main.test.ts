import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAgent, ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';
import {
  createLiveReviewAgent,
  createOpenAiChatModel,
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
  '.agents',
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

test('loadEnvSecrets walks off the filesystem root and parses quoted values', () => {
  expect(loadEnvSecrets('/')).toBeUndefined();
  const dir = mkdtempSync(join(tmpdir(), 'ai-skills-env-'));
  writeFileSync(
    join(dir, '.env.secrets'),
    ['# comment', 'NOTKEY', 'QUOTED="value"', "SINGLE='x'", 'EMPTY=', 'ALREADY=keep'].join('\n'),
  );
  const previous = {
    QUOTED: process.env.QUOTED,
    SINGLE: process.env.SINGLE,
    EMPTY: process.env.EMPTY,
    ALREADY: process.env.ALREADY,
  };
  process.env.ALREADY = 'keep';
  process.env.EMPTY = '';
  try {
    expect(loadEnvSecrets(dir)).toBe(join(dir, '.env.secrets'));
    expect(process.env.QUOTED).toBe('value');
    expect(process.env.SINGLE).toBe('x');
    expect(process.env.EMPTY).toBe('');
    expect(process.env.ALREADY).toBe('keep');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test('CLI main gate prints a live result when isMain is true', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runAiSkillsMain(true, async () => ({ content: 'review', usedTools: ['Skill'] }));
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test('createLiveReviewAgent and createOpenAiChatModel require a key', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  try {
    expect(createOpenAiChatModel()).toBeDefined();
    expect(createLiveReviewAgent(new ScriptedChatModel([{ respond: 'ok' }]))).toBeInstanceOf(
      ChatAgent,
    );
    expect(requireOpenAiApiKey()).toBe('sk-test');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('requireOpenAiApiKey loads .env.secrets when process env is empty', () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const key = requireOpenAiApiKey();
    if (previous || loadEnvSecrets()) {
      expect(key.length).toBeGreaterThan(0);
    }
  } catch (error) {
    expect(String(error)).toMatch(/OPENAI_API_KEY is not set/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('runLiveExample without a model uses OpenAiChatModel', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 'c',
        choices: [
          { message: { role: 'assistant', content: 'mocked review' }, finish_reason: 'stop' },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const result = await runLiveExample();
    expect(result.content).toContain('mocked review');
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test.skipIf(!hasOpenAiKey || process.env.CI === 'true' || process.env.RUN_LIVE_SKILLS !== '1')(
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
