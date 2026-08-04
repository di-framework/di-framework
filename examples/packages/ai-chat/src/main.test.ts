import { expect, test } from 'bun:test';
import { runExample } from './main.ts';

test('runs annotation-first chat, tool, and RAG flow without live credentials', async () => {
  await expect(runExample()).resolves.toContain('two-year warranty');
});
