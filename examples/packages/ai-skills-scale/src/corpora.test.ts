import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runRetrievalEvaluation } from './evaluation.ts';
import {
  GITSKILLS_SHARD_MANIFEST_SHA256,
  runMaterializeMain,
  selectionSql,
  shardManifestText,
  validateGitSkillsManifest,
} from './materialize-gitskills.ts';

const corporaRoot = join(import.meta.dir, '..', 'corpora');

describe('pinned evaluation corpora', () => {
  test.each(['gitskills-1000.json', 'gitskills-10000.json'])(
    'validates the deterministic %s manifest',
    async (name) => {
      const manifest = validateGitSkillsManifest(await readJson(join(corporaRoot, name)));
      expect(manifest.id).toBe(name.replace('.json', ''));
      expect(manifest.selection.size).toBe(name.includes('10000') ? 10_000 : 1_000);
    },
  );

  test('canonicalizes shard metadata and builds stable selection SQL', () => {
    const text = shardManifestText([
      { path: 'b.parquet', size: 2, lfs: { oid: 'bb', size: 2 } },
      { path: 'a.parquet', size: 1, lfs: { oid: 'aa', size: 1 } },
    ]);
    expect(text).toBe('a.parquet\t1\taa\nb.parquet\t2\tbb\n');
    const sql = selectionSql(["/tmp/one's.parquet"], "/tmp/out's.jsonl", 1_000, ['pdf']);
    expect(sql).toContain("'/tmp/one''s.parquet'");
    expect(sql).toContain('PARTITION BY name');
    expect(sql).toContain("CASE WHEN name IN ('pdf') THEN 0");
    expect(sql).toContain('ORDER BY file_sha, repo_full_name, path');
    expect(sql).toContain('LIMIT 1000');
    expect(GITSKILLS_SHARD_MANIFEST_SHA256).toHaveLength(64);
  });

  test('versions pre-tuning targets and all required hard-query labels', async () => {
    const targets = (await readJson(join(corporaRoot, 'quality-targets.v1.json'))) as {
      measuredResults: boolean;
      suites: Record<string, Record<string, number>>;
    };
    expect(targets.measuredResults).toBe(false);
    expect(targets.suites['awesome-copilot-408-baseline']).toMatchObject({
      positiveCases: 30,
      minimumRecallAt1: 29 / 30,
      minimumRecallAt10: 1,
    });
    const labels = (await readJson(join(corporaRoot, 'hard-cases.v1.json'))) as {
      cases: Array<{ kind: string }>;
    };
    const kinds = new Set(labels.cases.map((item: { kind: string }) => item.kind));
    for (const kind of [
      'hard',
      'ambiguous',
      'multi-skill',
      'no-skill',
      'typo',
      'multilingual',
      'long-context',
      'adversarial',
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  test('runs the tiny deterministic regression fixture in CI', async () => {
    const fixture = (await readJson(join(corporaRoot, 'ci-fixture.v1.json'))) as {
      skills: unknown[];
      cases: Array<{
        id: string;
        kind: 'unique' | 'typo' | 'no-skill';
        prompt: string;
        relevantSkills: string[];
      }>;
    };
    expect(fixture.skills).toHaveLength(3);
    expect(fixture.cases).toHaveLength(3);
    expect(fixture.cases.find((item: { kind: string }) => item.kind === 'no-skill')).toBeDefined();
    const result = await runRetrievalEvaluation({
      suite: 'tiny CI fixture',
      corpus: { id: 'ci-fixture.v1', revision: 'version-1', skillCount: fixture.skills.length },
      cases: fixture.cases,
      now: () => 0,
      memoryUsage: () => 0,
      retrieve: (evaluationCase) => ({
        candidates: evaluationCase.relevantSkills.map((name) => ({ name, score: 1 })),
      }),
    });
    expect(result.metrics).toMatchObject({
      recallAt1: 1,
      recallAt10: 1,
      abstentionRate: 1,
      noSkillFalsePositiveRate: 0,
    });
  });

  test('keeps extended materialization opt-in when imported', async () => {
    await expect(runMaterializeMain(false)).resolves.toBeUndefined();
  });
});

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await Bun.file(file).text());
}
