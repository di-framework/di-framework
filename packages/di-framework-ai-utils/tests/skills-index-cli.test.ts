import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SKILLS_INDEX_CHUNK_TOKENS,
  parseSkillsIndexCliArgs,
  runSkillsIndexCli,
  type SkillEmbedder,
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
    expect(() => parseSkillsIndexCliArgs(['--threshold', '-1'])).toThrow(/non-negative integer/);
    expect(() => parseSkillsIndexCliArgs(['--limit', '0'])).toThrow(/positive integer/);
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

  test('reports embedding progress and reuses an unchanged generated index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-index-cli-large-'));
    const skillDirectory = join(root, 'skills', 'alpha');
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: alpha\ndescription: Use for alpha work.\n---\n\nDo alpha work.\n',
    );
    const embedder: SkillEmbedder = {
      id: 'cli-test@1',
      model: 'cli-test',
      revision: '1',
      async split() {
        return Array.from({ length: 300 }, (_, index) => `chunk ${index}`);
      },
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    const logs: string[] = [];
    const io = { log: (message: string) => logs.push(message), error: () => undefined };
    const args = [
      '--skills-dir',
      'skills',
      '--output',
      'generated/skills.jsonl',
      '--threshold',
      '0',
    ];

    await expect(runSkillsIndexCli(args, io, root, { embedder })).resolves.toMatchObject({
      indexed: true,
      chunkCount: 300,
    });
    expect(logs.join('\n')).toContain('embedded 256/300 chunks');
    expect(logs.join('\n')).toContain('300 chunks x 2 dimensions');

    logs.length = 0;
    await expect(runSkillsIndexCli(args, io, root, { embedder })).resolves.toMatchObject({
      unchanged: true,
    });
    expect(logs.join('\n')).toContain('unchanged');

    logs.length = 0;
    await runSkillsIndexCli(['inspect', '--input', 'generated/skills.jsonl', '--json'], io, root, {
      embedder,
    });
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      schema: '@di-framework/skills-index-diagnostic',
      version: 1,
      command: 'inspect',
      metadata: { version: 3, skillCount: 1 },
    });
    expect(logs[0]).not.toContain('Do alpha work');

    logs.length = 0;
    await runSkillsIndexCli(
      ['query', '--input', 'generated/skills.jsonl', '--query', 'alpha', '--json'],
      io,
      root,
      { embedder },
    );
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      command: 'query',
      decision: 'selected',
      matches: [{ name: 'alpha', matchedChunk: 0 }],
    });

    logs.length = 0;
    await runSkillsIndexCli(
      ['validate', '--input', 'generated/skills.jsonl', '--skills-dir', 'skills', '--json'],
      io,
      root,
    );
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      command: 'validate',
      integrity: 'valid',
      sourceDrift: null,
    });

    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n\nChanged body.\n');
    logs.length = 0;
    await expect(
      runSkillsIndexCli(
        ['validate', '--input', 'generated/skills.jsonl', '--skills-dir', 'skills', '--json'],
        io,
        root,
      ),
    ).rejects.toThrow('stale');
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      command: 'validate',
      integrity: 'valid',
    });
    expect(JSON.parse(logs[0] ?? '{}').sourceDrift).toContain('stale');
  });

  test('migrates legacy JSONL without exposing bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-index-cli-migrate-'));
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1, 0);
    const metadata = {
      kind: '@di-framework/ai-utils/skills-index',
      version: 2,
      indexed: true,
      skillCount: 1,
      chunkCount: 1,
      threshold: 0,
      retrievalLimit: 1,
      chunkTokens: 256,
      chunkOverlapTokens: 32,
      scoring: 'frontmatter-guided-document-cosine-v1',
      vectorEncoding: 'float32-le-base64',
      catalogHash: 'legacy',
      model: 'fixture',
      revision: '1',
      embedderId: 'fixture@1',
      dimensions: 2,
    };
    const entry = {
      kind: 'skill',
      name: 'legacy',
      description: 'safe description',
      documentHash: 'hash',
      chunks: [{ source: 'document', vector: vector.toString('base64') }],
    };
    writeFileSync(
      join(root, 'v2.jsonl'),
      `${JSON.stringify(metadata)}\n${JSON.stringify(entry)}\n`,
    );
    const logs: string[] = [];
    await runSkillsIndexCli(
      ['migrate', '--input', 'v2.jsonl', '--output', 'v3.json', '--json'],
      { log: (message) => logs.push(message), error: () => undefined },
      root,
    );
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      command: 'migrate',
      fromVersion: 2,
      toVersion: 3,
    });
    expect(JSON.parse(readFileSync(join(root, 'v3.json'), 'utf8')).metadata.version).toBe(3);
  });
});
