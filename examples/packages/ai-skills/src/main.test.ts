import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ChatAgent, ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';
import { createReviewAgent, exampleRoot, exampleSkillsToolbox } from './main.ts';

const checklist = join(
  exampleRoot,
  '.claude',
  'skills',
  'code-reviewer',
  'references',
  'checklist.md',
);

test('toolbox loads the committed example skill', () => {
  const box = exampleSkillsToolbox();
  expect(box.skills.map((s) => s.name)).toEqual(['code-reviewer']);
  expect(box.tools.map((t) => t.toolDefinition.name)).toEqual(['Skill', 'Read', 'Glob']);
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
