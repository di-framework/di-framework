import { expect, test } from 'bun:test';
import { runExample, runGraphExample } from './main.ts';

test('runs annotation-first chat, tool, and RAG flow without live credentials', async () => {
  await expect(runExample()).resolves.toContain('two-year warranty');
});

test('runs graph workflow routing and tool-loop example without live credentials', async () => {
  const result = await runGraphExample();
  expect(result.routed).toContain('Billing');
  expect(result.toolLoop).toContain('weekday');
  expect(result.path).toContain('classify');
  expect(result.path).toContain('billing');
});
