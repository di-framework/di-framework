import { expect, spyOn, test } from 'bun:test';
import {
  runAiChatMain,
  runExample,
  runGraphExample,
  runPlannerAndA2AExample,
  SupportAssistant,
} from './main.ts';

test('runs annotation-first chat, tool, and RAG flow without live credentials', async () => {
  await expect(runExample()).resolves.toContain('two-year warranty');
});

test('runs graph workflow routing and tool-loop example without live credentials', async () => {
  const result = await runGraphExample();
  expect(result.routed).toContain('Billing');
  expect(result.technical).toContain('Technical');
  expect(result.general).toContain('General');
  expect(result.toolLoop).toContain('weekday');
  expect(result.path).toContain('classify');
  expect(result.path).toContain('billing');
});

test('ask() placeholder throws when called without the AI annotation proxy', () => {
  // `resolveAiService` swaps in a real implementation at runtime; calling the
  // decorated method directly on a bare instance hits the placeholder body.
  const assistant = new SupportAssistant();
  expect(() => assistant.ask('anything')).toThrow(
    'The annotation proxy supplies this method at runtime.',
  );
});

test('runs planner-executor and in-process A2A without live credentials', async () => {
  const result = await runPlannerAndA2AExample();
  expect(result.plannerAnswer).toContain('weekday');
  expect(result.a2aArticle).toContain('Article');
  expect(result.a2aArticle).toContain('notes:');
});

test('runs the CLI main gate when isMain is true', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runAiChatMain(true);
  } finally {
    log.mockRestore();
  }
});
