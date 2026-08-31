import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvSecrets, parseEnvFile, requireEnv, requireOpenAiApiKey } from '../src/index.ts';

describe('examples-shared env helpers', () => {
  test('parseEnvFile strips quotes and ignores comments', () => {
    expect(parseEnvFile('# comment\nFOO=bar\nQUOTED="from-file"\nSINGLE=\'x\'\nEMPTY=\n')).toEqual({
      FOO: 'bar',
      QUOTED: 'from-file',
      SINGLE: 'x',
      EMPTY: '',
    });
  });

  test('requireOpenAiApiKey prefers process env', () => {
    expect(requireOpenAiApiKey({ OPENAI_API_KEY: ' direct ' }, '/')).toBe('direct');
  });

  test('requireOpenAiApiKey loads ancestor .env.secrets without mutating when env is a copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'examples-shared-key-'));
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.env.secrets'), 'OTHER=x\nOPENAI_API_KEY="from-file"\n');
    expect(requireOpenAiApiKey({}, nested)).toBe('from-file');
  });

  test('requireOpenAiApiKey fails when missing', () => {
    const missingKeyRoot = mkdtempSync(join(tmpdir(), 'examples-shared-no-key-'));
    expect(() => requireOpenAiApiKey({}, missingKeyRoot)).toThrow(/OPENAI_API_KEY/);
    expect(() => requireOpenAiApiKey({}, '/')).toThrow(/OPENAI_API_KEY/);
  });

  test('loadEnvSecrets fills missing process.env keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'examples-shared-load-'));
    writeFileSync(join(root, '.env.secrets'), 'SHARED_DEMO_KEY="loaded"\n');
    const previous = process.env.SHARED_DEMO_KEY;
    delete process.env.SHARED_DEMO_KEY;
    try {
      expect(loadEnvSecrets(root)).toBe(join(root, '.env.secrets'));
      expect(String(process.env.SHARED_DEMO_KEY)).toBe('loaded');
      expect(requireEnv('SHARED_DEMO_KEY', { startDir: root })).toBe('loaded');
    } finally {
      if (previous === undefined) delete process.env.SHARED_DEMO_KEY;
      else process.env.SHARED_DEMO_KEY = previous;
    }
  });
});
