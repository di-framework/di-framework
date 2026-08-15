import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SKILLS_INDEX_CHUNK_TOKENS,
  parseSkillsIndexCliArgs,
  runSkillsIndexCli,
} from '../src/index.ts';

describe('di-skills-index', () => {
  test('parses repeatable sources and index controls', () => {
    const options = parseSkillsIndexCliArgs([
      '--skills-dir',
      'one',
      '--directory',
      'two',
      '--skill-file',
      'single.md',
      '--output',
      'index.jsonl',
      '--threshold',
      '12',
      '--limit',
      '7',
      '--chunk-tokens',
      '128',
      '--chunk-overlap',
      '16',
      '--batch-size',
      '8',
      '--force',
      '--if-present',
    ]);
    expect(options).toMatchObject({
      directories: ['one', 'two'],
      files: ['single.md'],
      outputFile: 'index.jsonl',
      threshold: 12,
      retrievalLimit: 7,
      chunkTokens: 128,
      chunkOverlapTokens: 16,
      batchSize: 8,
      force: true,
      ifPresent: true,
    });
    expect(parseSkillsIndexCliArgs([]).chunkTokens).toBe(DEFAULT_SKILLS_INDEX_CHUNK_TOKENS);
    expect(() => parseSkillsIndexCliArgs(['--chunk-tokens', '8', '--chunk-overlap', '8'])).toThrow(
      /smaller/,
    );
    expect(() => parseSkillsIndexCliArgs(['--unknown'])).toThrow(/Unknown option/);
  });

  test('builds metadata without loading Transformers.js below the threshold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-index-cli-'));
    const skillDirectory = join(root, 'skills', 'alpha');
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: alpha\ndescription: Use for alpha work.\n---\n\nDo alpha work.\n',
    );
    const logs: string[] = [];
    const io = { log: (message: string) => logs.push(message), error: () => undefined };
    const result = await runSkillsIndexCli(
      ['--skills-dir', 'skills', '--output', 'generated/skills.jsonl', '--threshold', '1'],
      io,
      root,
    );
    expect(result).toMatchObject({ indexed: false, skillCount: 1, chunkCount: 0 });
    expect(logs.join('\n')).toContain('metadata only');
  });

  test('supports help and optional missing sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-index-cli-empty-'));
    const logs: string[] = [];
    const io = { log: (message: string) => logs.push(message), error: () => undefined };
    await expect(runSkillsIndexCli(['--help'], io, root)).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('di-skills-index');
    await expect(
      runSkillsIndexCli(['--skills-dir', 'missing', '--if-present'], io, root),
    ).resolves.toBeUndefined();
    await expect(runSkillsIndexCli(['--skills-dir', 'missing'], io, root)).rejects.toThrow(
      /No skill source/,
    );
  });
});
