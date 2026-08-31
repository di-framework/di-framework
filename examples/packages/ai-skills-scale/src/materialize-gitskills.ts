import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exampleRoot } from './corpus.ts';

export const GITSKILLS_DATASET = 'mvaccargiu/gitskills';
export const GITSKILLS_REVISION = '289a292b3c6b175df1331f5ad2715673ba42dead';
export const GITSKILLS_SHARD_COUNT = 31;
export const GITSKILLS_SHARD_BYTES = 6_449_224_347;
export const GITSKILLS_SHARD_MANIFEST_SHA256 =
  'ea717c790c6f0c6ca93f003cf17d667a8a1ca7a625109d34658d5490a8c8afe9';

interface HuggingFaceTreeEntry {
  readonly path: string;
  readonly size: number;
  readonly lfs?: { readonly oid: string; readonly size: number };
}

export interface GitSkillsManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: {
    readonly dataset: string;
    readonly revision: string;
    readonly shardCount: number;
    readonly shardBytes: number;
    readonly shardManifestSha256: string;
  };
  readonly selection: {
    readonly size: number;
    readonly algorithm: 'gitskills-anchored-lowest-content-hash-v1';
    readonly requiredLabelAnchors: readonly string[];
  };
}

interface SelectedSkill {
  readonly name: string;
  readonly content: string;
  readonly file_sha: string;
  readonly repo_full_name: string;
  readonly path: string;
}

export function validateGitSkillsManifest(value: unknown): GitSkillsManifest {
  const manifest = value as Partial<GitSkillsManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.id ||
    manifest.source?.dataset !== GITSKILLS_DATASET ||
    manifest.source.revision !== GITSKILLS_REVISION ||
    manifest.source.shardCount !== GITSKILLS_SHARD_COUNT ||
    manifest.source.shardBytes !== GITSKILLS_SHARD_BYTES ||
    manifest.source.shardManifestSha256 !== GITSKILLS_SHARD_MANIFEST_SHA256 ||
    manifest.selection?.algorithm !== 'gitskills-anchored-lowest-content-hash-v1' ||
    !Array.isArray(manifest.selection.requiredLabelAnchors) ||
    manifest.selection.requiredLabelAnchors.length === 0 ||
    !Number.isInteger(manifest.selection.size) ||
    (manifest.selection.size ?? 0) < 1
  ) {
    throw new Error('GitSkills manifest does not match the pinned dataset and selection schema');
  }
  const expectedSize =
    manifest.id === 'gitskills-1000' ? 1_000 : manifest.id === 'gitskills-10000' ? 10_000 : 0;
  if (manifest.selection.size !== expectedSize) {
    throw new Error('GitSkills manifest id and subset size do not match an allowed output');
  }
  return manifest as GitSkillsManifest;
}

export function shardManifestText(entries: readonly HuggingFaceTreeEntry[]): string {
  return entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\t${entry.size}\t${entry.lfs?.oid ?? ''}\n`)
    .join('');
}

export function selectionSql(
  shardFiles: readonly string[],
  outputFile: string,
  size: number,
  requiredLabelAnchors: readonly string[] = [],
): string {
  if (shardFiles.length === 0) throw new Error('At least one GitSkills shard is required');
  if (!Number.isInteger(size) || size < 1)
    throw new Error('Subset size must be a positive integer');
  const files = shardFiles.map((file) => `'${escapeSql(file)}'`).join(', ');
  const anchors = requiredLabelAnchors.map((name) => `'${escapeSql(name)}'`).join(', ');
  const anchorOrder = anchors ? `CASE WHEN name IN (${anchors}) THEN 0 ELSE 1 END, ` : '';
  return `COPY (
  WITH eligible AS (
    SELECT name, content, file_sha, repo_full_name, path,
      row_number() OVER (PARTITION BY name ORDER BY file_sha, repo_full_name, path) AS name_rank
    FROM read_parquet([${files}])
    WHERE dedup_primary = 1
      AND content_fetched = 1
      AND frontmatter_valid = 1
      AND content_sha_ok = 1
      AND regexp_full_match(name, '^[a-z0-9]+(-[a-z0-9]+)*$')
      AND length(name) <= 64
      AND length(description) BETWEEN 1 AND 1024
  )
  SELECT name, content, file_sha, repo_full_name, path
  FROM eligible
  WHERE name_rank = 1
  ORDER BY ${anchorOrder}file_sha, repo_full_name, path
  LIMIT ${size}
) TO '${escapeSql(outputFile)}' (FORMAT JSON, ARRAY false);`;
}

export async function materializeGitSkills(manifestFile: string): Promise<void> {
  const manifest = validateGitSkillsManifest(JSON.parse(await Bun.file(manifestFile).text()));
  const cacheRoot = join(exampleRoot, '.cache', 'gitskills', GITSKILLS_REVISION);
  const shardsRoot = join(cacheRoot, 'artifacts');
  const subsetRoot = join(exampleRoot, '.cache', manifest.id);
  const selectedFile = join(cacheRoot, `${manifest.id}.jsonl`);
  mkdirSync(shardsRoot, { recursive: true });

  const entries = await fetchShardEntries();
  const sourceBytes = entries.reduce((total, entry) => total + entry.size, 0);
  const sourceHash = new Bun.CryptoHasher('sha256')
    .update(shardManifestText(entries))
    .digest('hex');
  if (
    entries.length !== manifest.source.shardCount ||
    sourceBytes !== manifest.source.shardBytes ||
    sourceHash !== manifest.source.shardManifestSha256
  ) {
    throw new Error('Pinned GitSkills shard manifest hash, count, or size did not match');
  }

  const shardFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.lfs) throw new Error(`GitSkills shard lacks an LFS hash: ${entry.path}`);
    const destination = join(shardsRoot, basename(entry.path));
    if (!(await fileMatches(destination, entry.size, entry.lfs.oid))) {
      console.log(`fetching ${entry.path} (${entry.size} bytes)`);
      const response = await fetch(
        `https://huggingface.co/datasets/${GITSKILLS_DATASET}/resolve/${GITSKILLS_REVISION}/${entry.path}`,
      );
      if (!response.ok) throw new Error(`GitSkills download failed: ${response.status}`);
      await Bun.write(destination, response);
      if (!(await fileMatches(destination, entry.size, entry.lfs.oid))) {
        throw new Error(`GitSkills shard checksum failed: ${entry.path}`);
      }
    }
    shardFiles.push(destination);
  }

  const duckdb = Bun.which('duckdb');
  if (!duckdb) throw new Error('The extended GitSkills benchmark requires the duckdb CLI');
  const query = selectionSql(
    shardFiles,
    selectedFile,
    manifest.selection.size,
    manifest.selection.requiredLabelAnchors,
  );
  const extraction = Bun.spawnSync([duckdb, ':memory:', query], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (extraction.exitCode !== 0) throw new Error(`duckdb exited with ${extraction.exitCode}`);

  const records = (await Bun.file(selectedFile).text())
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SelectedSkill);
  if (records.length !== manifest.selection.size) {
    throw new Error(
      `Selected ${records.length} GitSkills records; expected ${manifest.selection.size}`,
    );
  }
  const names = new Set(records.map((record) => record.name));
  const missingAnchors = manifest.selection.requiredLabelAnchors.filter((name) => !names.has(name));
  if (missingAnchors.length > 0) {
    throw new Error(
      `Pinned GitSkills subset lacks required label anchors: ${missingAnchors.join(', ')}`,
    );
  }
  rmSync(subsetRoot, { recursive: true, force: true });
  mkdirSync(subsetRoot, { recursive: true });
  for (const record of records) {
    const directory = join(subsetRoot, record.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), record.content);
  }
  const selectionHash = new Bun.CryptoHasher('sha256')
    .update(
      records
        .map((record) => `${record.file_sha}\t${record.repo_full_name}\t${record.path}\n`)
        .join(''),
    )
    .digest('hex');
  writeFileSync(
    join(subsetRoot, 'selection-receipt.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        manifest: manifest.id,
        sourceRevision: manifest.source.revision,
        skillCount: records.length,
        selectionSha256: selectionHash,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${manifest.id}: ${records.length} skills, selection sha256 ${selectionHash}`);
  console.log(subsetRoot);
}

async function fetchShardEntries(): Promise<readonly HuggingFaceTreeEntry[]> {
  const response = await fetch(
    `https://huggingface.co/api/datasets/${GITSKILLS_DATASET}/tree/${GITSKILLS_REVISION}/data/artifacts?recursive=false&expand=true&limit=100`,
  );
  if (!response.ok) throw new Error(`GitSkills tree request failed: ${response.status}`);
  const entries = (await response.json()) as HuggingFaceTreeEntry[];
  return entries.filter((entry) => entry.path.endsWith('.parquet'));
}

async function fileMatches(file: string, bytes: number, sha256: string): Promise<boolean> {
  const candidate = Bun.file(file);
  if (!(await candidate.exists()) || candidate.size !== bytes) return false;
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of candidate.stream()) hasher.update(chunk);
  return hasher.digest('hex') === sha256;
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

export async function runMaterializeMain(
  isMain = import.meta.main,
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (!isMain) return;
  const manifest = args[0];
  if (!manifest) {
    throw new Error('Usage: bun run materialize:gitskills -- corpora/gitskills-1000.json');
  }
  await materializeGitSkills(manifest);
}

await runMaterializeMain();
