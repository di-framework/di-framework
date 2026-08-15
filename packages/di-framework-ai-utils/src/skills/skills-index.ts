import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expandUserPath } from '../sandbox/paths.ts';
import type { AgentSkill } from './parse-skill-markdown.ts';
import { type SkillEmbedder, TransformersJsSkillEmbedder } from './skill-embedder.ts';
import { collectSkills } from './skills-tool.ts';
import { validateSkill } from './validate-skill.ts';

export const SKILLS_INDEX_FORMAT = '@di-framework/ai-utils/skills-index';
export const SKILLS_INDEX_VERSION = 2;
export const SKILLS_INDEX_VECTOR_ENCODING = 'float32-le-base64';
export const SKILLS_INDEX_SCORING = 'frontmatter-guided-document-cosine-v1';
export const SKILLS_INDEX_FIRST_CHUNK_WEIGHT = 0.75;
export const DEFAULT_SKILLS_INDEX_FILE = '.di-framework/skills-index.jsonl';
export const DEFAULT_SKILLS_INDEX_THRESHOLD = 50;
export const DEFAULT_SKILLS_RETRIEVAL_LIMIT = 10;
export const DEFAULT_SKILLS_INDEX_BATCH_SIZE = 32;
export const DEFAULT_SKILLS_INDEX_CHUNK_TOKENS = 256;
export const DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS = 32;

export type SkillsIndexChunkSource = 'document';

export interface SkillsIndexMetadata {
  readonly kind: typeof SKILLS_INDEX_FORMAT;
  readonly version: typeof SKILLS_INDEX_VERSION;
  readonly indexed: boolean;
  readonly skillCount: number;
  readonly chunkCount: number;
  readonly threshold: number;
  readonly retrievalLimit: number;
  readonly chunkTokens: number;
  readonly chunkOverlapTokens: number;
  readonly scoring: typeof SKILLS_INDEX_SCORING;
  readonly vectorEncoding: typeof SKILLS_INDEX_VECTOR_ENCODING;
  readonly catalogHash: string;
  readonly model?: string;
  readonly revision?: string;
  readonly embedderId?: string;
  readonly dimensions?: number;
}

export interface SkillsIndexChunk {
  readonly source: SkillsIndexChunkSource;
  readonly embedding: Float32Array;
}

export interface SkillsIndexEntry {
  readonly kind: 'skill';
  readonly name: string;
  readonly description: string;
  readonly documentHash: string;
  readonly chunks: readonly SkillsIndexChunk[];
}

export interface SkillsIndex {
  readonly file?: string;
  readonly metadata: SkillsIndexMetadata;
  readonly entries: readonly SkillsIndexEntry[];
}

export interface BuildSkillsIndexOptions {
  readonly skills?: readonly AgentSkill[];
  readonly directories?: readonly string[];
  readonly files?: readonly string[];
  readonly outputFile?: string;
  /** Build embeddings only when skill count is strictly greater than this value. */
  readonly threshold?: number;
  readonly retrievalLimit?: number;
  readonly batchSize?: number;
  readonly chunkTokens?: number;
  readonly chunkOverlapTokens?: number;
  readonly embedder?: SkillEmbedder;
  readonly force?: boolean;
  /** Reports embedded chunks, not skills. */
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface BuildSkillsIndexResult {
  readonly outputFile: string;
  readonly indexed: boolean;
  readonly skillCount: number;
  readonly chunkCount: number;
  readonly dimensions?: number;
  readonly unchanged?: boolean;
}

/** Preferred build-time factory for a semantic Agent Skills index. */
export const SkillsIndex = {
  builder(): SkillsIndexBuilder {
    return new SkillsIndexBuilder();
  },
};

/** Fluent builder for the generated JSONL skills index. */
export class SkillsIndexBuilder {
  private readonly draft: {
    -readonly [K in keyof BuildSkillsIndexOptions]?: BuildSkillsIndexOptions[K];
  } = {};

  addSkill(skill: AgentSkill): this {
    this.draft.skills = [...(this.draft.skills ?? []), skill];
    return this;
  }

  addSkills(skills: readonly AgentSkill[]): this {
    this.draft.skills = [...(this.draft.skills ?? []), ...skills];
    return this;
  }

  addSkillsDirectory(directory: string): this {
    this.draft.directories = [...(this.draft.directories ?? []), directory];
    return this;
  }

  addSkillsDirectories(directories: readonly string[]): this {
    this.draft.directories = [...(this.draft.directories ?? []), ...directories];
    return this;
  }

  addSkillsFile(skillMdPath: string): this {
    this.draft.files = [...(this.draft.files ?? []), skillMdPath];
    return this;
  }

  addSkillsFiles(skillMdPaths: readonly string[]): this {
    this.draft.files = [...(this.draft.files ?? []), ...skillMdPaths];
    return this;
  }

  outputFile(path: string): this {
    this.draft.outputFile = path;
    return this;
  }

  threshold(count: number): this {
    this.draft.threshold = count;
    return this;
  }

  retrievalLimit(count: number): this {
    this.draft.retrievalLimit = count;
    return this;
  }

  batchSize(count: number): this {
    this.draft.batchSize = count;
    return this;
  }

  chunkTokens(count: number): this {
    this.draft.chunkTokens = count;
    return this;
  }

  chunkOverlapTokens(count: number): this {
    this.draft.chunkOverlapTokens = count;
    return this;
  }

  embedder(embedder: SkillEmbedder): this {
    this.draft.embedder = embedder;
    return this;
  }

  force(enabled = true): this {
    this.draft.force = enabled;
    return this;
  }

  onProgress(handler: (completed: number, total: number) => void): this {
    this.draft.onProgress = handler;
    return this;
  }

  toOptions(): BuildSkillsIndexOptions {
    return { ...this.draft };
  }

  build(): Promise<BuildSkillsIndexResult> {
    return buildSkillsIndex(this.toOptions());
  }
}

export interface SearchSkillsIndexOptions {
  readonly embedder?: SkillEmbedder;
  readonly limit?: number;
  readonly minScore?: number;
}

export interface SkillsIndexMatch {
  readonly name: string;
  readonly description: string;
  readonly score: number;
  readonly matchedChunk: number;
  readonly matchedSource: SkillsIndexChunkSource;
}

export interface SkillsIndexEntryScore {
  readonly score: number;
  readonly matchedChunk: number;
  readonly matchedSource: SkillsIndexChunkSource;
}

/** Exact SKILL.md source used for chunking and catalog hashing. */
export function skillIndexText(skill: Pick<AgentSkill, 'source'>): string {
  return skill.source;
}

/**
 * Build a deterministic JSONL artifact. Catalogs at or below the threshold
 * write only metadata and never initialize Transformers.js.
 */
export async function buildSkillsIndex(
  options: BuildSkillsIndexOptions = {},
): Promise<BuildSkillsIndexResult> {
  const threshold = nonNegativeInteger(
    options.threshold ?? DEFAULT_SKILLS_INDEX_THRESHOLD,
    'threshold',
  );
  const retrievalLimit = positiveInteger(
    options.retrievalLimit ?? DEFAULT_SKILLS_RETRIEVAL_LIMIT,
    'retrievalLimit',
  );
  const batchSize = positiveInteger(
    options.batchSize ?? DEFAULT_SKILLS_INDEX_BATCH_SIZE,
    'batchSize',
  );
  const chunkTokens = positiveInteger(
    options.chunkTokens ?? DEFAULT_SKILLS_INDEX_CHUNK_TOKENS,
    'chunkTokens',
  );
  const chunkOverlapTokens = nonNegativeInteger(
    options.chunkOverlapTokens ?? DEFAULT_SKILLS_INDEX_CHUNK_OVERLAP_TOKENS,
    'chunkOverlapTokens',
  );
  if (chunkOverlapTokens >= chunkTokens) {
    throw new Error('chunkOverlapTokens must be smaller than chunkTokens');
  }

  const outputFile = resolve(expandUserPath(options.outputFile ?? DEFAULT_SKILLS_INDEX_FILE));
  const skills = collectSkills(options)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const skill of skills) {
    validateSkill(skill, { matchDirectoryName: skill.basePath !== '.' });
  }

  const catalogHash = hashSkillCatalog(skills);
  const commonMetadata = {
    kind: SKILLS_INDEX_FORMAT,
    version: SKILLS_INDEX_VERSION,
    skillCount: skills.length,
    threshold,
    retrievalLimit,
    chunkTokens,
    chunkOverlapTokens,
    scoring: SKILLS_INDEX_SCORING,
    vectorEncoding: SKILLS_INDEX_VECTOR_ENCODING,
    catalogHash,
  } as const;

  if (skills.length <= threshold) {
    const metadata: SkillsIndexMetadata = {
      ...commonMetadata,
      indexed: false,
      chunkCount: 0,
    };
    writeJsonLinesAtomically(outputFile, [metadata]);
    return { outputFile, indexed: false, skillCount: skills.length, chunkCount: 0 };
  }

  const embedder = options.embedder ?? new TransformersJsSkillEmbedder();
  if (!options.force && existsSync(outputFile)) {
    try {
      const existing = loadSkillsIndex(outputFile);
      if (
        existing.metadata.indexed &&
        existing.metadata.catalogHash === catalogHash &&
        existing.metadata.threshold === threshold &&
        existing.metadata.retrievalLimit === retrievalLimit &&
        existing.metadata.chunkTokens === chunkTokens &&
        existing.metadata.chunkOverlapTokens === chunkOverlapTokens &&
        existing.metadata.embedderId === embedder.id
      ) {
        assertSkillsIndexCurrent(existing, skills);
        return {
          outputFile,
          indexed: true,
          skillCount: skills.length,
          chunkCount: existing.metadata.chunkCount,
          dimensions: existing.metadata.dimensions,
          unchanged: true,
        };
      }
    } catch {
      // A malformed or stale generated artifact is replaced below.
    }
  }

  const pendingChunks: Array<{
    skillIndex: number;
    source: SkillsIndexChunkSource;
    text: string;
  }> = [];
  for (let skillIndex = 0; skillIndex < skills.length; skillIndex++) {
    const skill = skills[skillIndex];
    if (!skill) continue;
    const documentChunks = await embedder.split(skillIndexText(skill), {
      maxTokens: chunkTokens,
      overlapTokens: chunkOverlapTokens,
    });
    for (const text of documentChunks) {
      pendingChunks.push({ skillIndex, source: 'document', text });
    }
  }
  if (pendingChunks.length === 0) throw new Error('Skill tokenizer returned no chunks');

  const chunksBySkill: SkillsIndexChunk[][] = skills.map(() => []);
  let dimensions: number | undefined;
  for (let start = 0; start < pendingChunks.length; start += batchSize) {
    const batch = pendingChunks.slice(start, start + batchSize);
    const embedded = await embedder.embed(
      batch.map((chunk) => chunk.text),
      { purpose: 'document' },
    );
    if (embedded.length !== batch.length) {
      throw new Error(
        `Skill embedder returned ${embedded.length} vectors for a batch of ${batch.length}`,
      );
    }
    for (let offset = 0; offset < embedded.length; offset++) {
      const chunk = batch[offset];
      const input = embedded[offset];
      if (!chunk || !input) throw new Error('Skill embedder omitted a chunk vector');
      const vector = normalizeVector(input);
      dimensions ??= vector.length;
      if (vector.length !== dimensions) {
        throw new Error(`Skill embedding has ${vector.length} dimensions; expected ${dimensions}`);
      }
      chunksBySkill[chunk.skillIndex]?.push({
        source: chunk.source,
        embedding: vector,
      });
    }
    options.onProgress?.(
      Math.min(start + batch.length, pendingChunks.length),
      pendingChunks.length,
    );
  }

  if (dimensions == null || dimensions === 0) {
    throw new Error('Skill embedder returned empty vectors');
  }

  const metadata: SkillsIndexMetadata = {
    ...commonMetadata,
    indexed: true,
    chunkCount: pendingChunks.length,
    model: embedder.model,
    revision: embedder.revision,
    embedderId: embedder.id,
    dimensions,
  };
  const entries: SkillsIndexEntry[] = skills.map((skill, index) => {
    const chunks = chunksBySkill[index];
    if (!chunks || chunks.length === 0) {
      throw new Error(`Missing chunks for skill '${skill.name}'`);
    }
    return {
      kind: 'skill',
      name: skill.name,
      description: skill.description ?? '',
      documentHash: hashText(skillIndexText(skill)),
      chunks,
    };
  });
  writeJsonLinesAtomically(outputFile, [metadata, ...entries.map(serializeEntry)]);
  return {
    outputFile,
    indexed: true,
    skillCount: skills.length,
    chunkCount: pendingChunks.length,
    dimensions,
  };
}

/** Parse and validate a generated skill index. */
export function loadSkillsIndex(file = DEFAULT_SKILLS_INDEX_FILE): SkillsIndex {
  const absolute = resolve(expandUserPath(file));
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(`Skills index does not exist or cannot be read: ${absolute}`, { cause: error });
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`Skills index is empty: ${absolute}`);

  const metadataLine = lines[0];
  if (metadataLine == null) throw new Error(`Skills index is empty: ${absolute}`);
  const metadata = parseMetadata(metadataLine, absolute);
  const entries = lines
    .slice(1)
    .map((line, index) => parseEntry(line, index + 2, absolute, metadata.dimensions));
  if (!metadata.indexed && entries.length > 0) {
    throw new Error(`Non-indexed skills artifact contains vector entries: ${absolute}`);
  }
  if (metadata.indexed && entries.length !== metadata.skillCount) {
    throw new Error(
      `Skills index contains ${entries.length} entries but metadata declares ${metadata.skillCount}: ${absolute}`,
    );
  }
  if (metadata.indexed) {
    const names = new Set<string>();
    let chunkCount = 0;
    for (const entry of entries) {
      if (names.has(entry.name)) throw new Error(`Duplicate skill '${entry.name}' in ${absolute}`);
      names.add(entry.name);
      chunkCount += entry.chunks.length;
    }
    if (chunkCount !== metadata.chunkCount) {
      throw new Error(
        `Skills index contains ${chunkCount} chunks but metadata declares ${metadata.chunkCount}: ${absolute}`,
      );
    }
  }
  return { file: absolute, metadata, entries };
}

/** Fail when indexed metadata or SKILL.md source no longer matches loaded skills. */
export function assertSkillsIndexCurrent(
  index: SkillsIndex,
  skills: readonly AgentSkill[],
  options: { allowExtraSkills?: boolean } = {},
): void {
  const map = new Map(skills.map((skill) => [skill.name, skill]));
  for (const entry of index.entries) {
    const skill = map.get(entry.name);
    if (!skill) {
      throw staleIndexError(index, `indexed skill '${entry.name}' is missing`);
    }
    if ((skill.description ?? '') !== entry.description) {
      throw staleIndexError(index, `description changed for '${entry.name}'`);
    }
    if (hashText(skillIndexText(skill)) !== entry.documentHash) {
      throw staleIndexError(index, `SKILL.md changed for '${entry.name}'`);
    }
  }
  if (!options.allowExtraSkills && hashSkillCatalog(skills) !== index.metadata.catalogHash) {
    throw staleIndexError(index, 'the loaded skill catalog changed');
  }
}

/** Embed a task and rank skills with frontmatter-guided SKILL.md chunk scores. */
export async function searchSkillsIndex(
  index: SkillsIndex,
  task: string,
  options: SearchSkillsIndexOptions = {},
): Promise<readonly SkillsIndexMatch[]> {
  if (!index.metadata.indexed) return [];
  const embedder =
    options.embedder ??
    new TransformersJsSkillEmbedder({
      model: index.metadata.model,
      revision: index.metadata.revision,
    });
  assertCompatibleEmbedder(index, embedder);
  const [query] = await embedder.embed([task], { purpose: 'query' });
  if (!query) throw new Error('Skill embedder did not return a query vector');
  return rankSkillsIndex(index, query, options);
}

/** Rank with an already-computed query vector using frontmatter-guided MaxSim. */
export function rankSkillsIndex(
  index: SkillsIndex,
  query: ArrayLike<number>,
  options: Pick<SearchSkillsIndexOptions, 'limit' | 'minScore'> = {},
): readonly SkillsIndexMatch[] {
  if (!index.metadata.indexed) return [];
  const dimensions = index.metadata.dimensions;
  if (dimensions == null) throw new Error('Indexed skills metadata is missing dimensions');
  if (query.length !== dimensions) {
    throw new Error(`Query embedding has ${query.length} dimensions; expected ${dimensions}`);
  }
  const limit = positiveInteger(options.limit ?? index.metadata.retrievalLimit, 'limit');
  const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
  if (Number.isNaN(minScore)) throw new Error('minScore must be a number');

  return index.entries
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      ...scoreSkillsIndexEntry(entry, query),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/**
 * The first raw document chunk contains routing frontmatter. Later chunks
 * contribute supporting evidence without allowing long generic bodies to
 * dominate candidate generation.
 */
export function scoreSkillsIndexEntry(
  entry: SkillsIndexEntry,
  query: ArrayLike<number>,
): SkillsIndexEntryScore {
  if (entry.chunks.length === 0) throw new Error(`Skill '${entry.name}' has no chunks`);
  let best: SkillsIndexEntryScore | undefined;
  let firstChunkScore: number | undefined;
  for (let chunkIndex = 0; chunkIndex < entry.chunks.length; chunkIndex++) {
    const chunk = entry.chunks[chunkIndex];
    if (!chunk) continue;
    const score = cosineSimilarity(query, chunk.embedding);
    firstChunkScore ??= score;
    if (!best || score > best.score) {
      best = { score, matchedChunk: chunkIndex, matchedSource: chunk.source };
    }
  }
  if (!best) throw new Error(`Skill '${entry.name}' has no scoreable chunks`);
  if (firstChunkScore == null) throw new Error(`Skill '${entry.name}' has no first chunk`);
  return {
    ...best,
    score:
      SKILLS_INDEX_FIRST_CHUNK_WEIGHT * firstChunkScore +
      (1 - SKILLS_INDEX_FIRST_CHUNK_WEIGHT) * best.score,
  };
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) {
    throw new Error(`Cannot compare vectors with dimensions ${left.length} and ${right.length}`);
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function hashSkillCatalog(skills: readonly Pick<AgentSkill, 'name' | 'source'>[]): string {
  const sorted = skills
    .map((skill) => ({
      name: skill.name,
      documentHash: hashText(skillIndexText(skill)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const hash = createHash('sha256');
  for (const skill of sorted) hash.update(`${JSON.stringify(skill)}\n`);
  return hash.digest('hex');
}

function assertCompatibleEmbedder(index: SkillsIndex, embedder: SkillEmbedder): void {
  if (
    embedder.id !== index.metadata.embedderId ||
    embedder.model !== index.metadata.model ||
    embedder.revision !== index.metadata.revision
  ) {
    throw new Error(
      `Skills index uses ${index.metadata.embedderId}, but the query embedder uses ${embedder.id}`,
    );
  }
}

function normalizeVector(input: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let index = 0; index < input.length; index++) {
    const value = Number(input[index]);
    if (!Number.isFinite(value)) throw new Error('Skill embedder returned a non-finite value');
    norm += value * value;
  }
  if (norm === 0) throw new Error('Skill embedder returned a zero vector');
  const scale = 1 / Math.sqrt(norm);
  return Float32Array.from(input, (value) => Number(value) * scale);
}

function serializeEntry(entry: SkillsIndexEntry): unknown {
  return {
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    documentHash: entry.documentHash,
    chunks: entry.chunks.map((chunk) => ({
      source: chunk.source,
      vector: encodeVector(chunk.embedding),
    })),
  };
}

function encodeVector(vector: Float32Array): string {
  const bytes = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index++) {
    bytes.writeFloatLE(vector[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return bytes.toString('base64');
}

function decodeVector(
  value: string,
  dimensions: number,
  file: string,
  lineNumber: number,
): Float32Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Invalid base64 vector at ${file}:${lineNumber}`);
  }
  const bytes = Buffer.from(value, 'base64');
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.length !== expectedBytes) {
    throw new Error(
      `Invalid vector length at ${file}:${lineNumber}; got ${bytes.length} bytes, expected ${expectedBytes}`,
    );
  }
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) {
    const number = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
    if (!Number.isFinite(number)) {
      throw new Error(`Non-finite vector value at ${file}:${lineNumber}`);
    }
    vector[index] = number;
  }
  return vector;
}

function writeJsonLinesAtomically(file: string, records: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function parseMetadata(line: string, file: string): SkillsIndexMetadata {
  const value = parseLine(line, 1, file) as Partial<SkillsIndexMetadata>;
  if (value.kind !== SKILLS_INDEX_FORMAT || value.version !== SKILLS_INDEX_VERSION) {
    throw new Error(`Unsupported skills index format or version: ${file}`);
  }
  if (
    typeof value.indexed !== 'boolean' ||
    !isNonNegativeInteger(value.skillCount) ||
    !isNonNegativeInteger(value.chunkCount) ||
    !isNonNegativeInteger(value.threshold) ||
    !isPositiveInteger(value.retrievalLimit) ||
    !isPositiveInteger(value.chunkTokens) ||
    !isNonNegativeInteger(value.chunkOverlapTokens) ||
    value.chunkOverlapTokens >= value.chunkTokens ||
    value.scoring !== SKILLS_INDEX_SCORING ||
    value.vectorEncoding !== SKILLS_INDEX_VECTOR_ENCODING ||
    typeof value.catalogHash !== 'string'
  ) {
    throw new Error(`Invalid skills index metadata: ${file}`);
  }
  if (
    value.indexed &&
    (typeof value.model !== 'string' ||
      typeof value.revision !== 'string' ||
      typeof value.embedderId !== 'string' ||
      !isPositiveInteger(value.dimensions) ||
      value.chunkCount < value.skillCount)
  ) {
    throw new Error(`Indexed skills metadata is missing model or chunk information: ${file}`);
  }
  if (!value.indexed && value.chunkCount !== 0) {
    throw new Error(`Non-indexed skills metadata declares chunks: ${file}`);
  }
  return value as SkillsIndexMetadata;
}

function parseEntry(
  line: string,
  lineNumber: number,
  file: string,
  dimensions?: number,
): SkillsIndexEntry {
  const value = parseLine(line, lineNumber, file) as {
    kind?: unknown;
    name?: unknown;
    description?: unknown;
    documentHash?: unknown;
    chunks?: unknown;
  };
  if (
    value.kind !== 'skill' ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.documentHash !== 'string' ||
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0 ||
    dimensions == null
  ) {
    throw new Error(`Invalid skill index entry at ${file}:${lineNumber}`);
  }
  const chunks = value.chunks.map((raw) => {
    const chunk = raw as { source?: unknown; vector?: unknown };
    if (chunk.source !== 'document' || typeof chunk.vector !== 'string') {
      throw new Error(`Invalid skill chunk at ${file}:${lineNumber}`);
    }
    const source: SkillsIndexChunkSource = chunk.source;
    return {
      source,
      embedding: decodeVector(chunk.vector, dimensions, file, lineNumber),
    };
  });
  return {
    kind: 'skill',
    name: value.name,
    description: value.description,
    documentHash: value.documentHash,
    chunks,
  };
}

function parseLine(line: string, lineNumber: number, file: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON at ${file}:${lineNumber}`, { cause: error });
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function staleIndexError(index: SkillsIndex, detail: string): Error {
  return new Error(
    `Skills index is stale (${detail}). Rebuild ${index.file ?? DEFAULT_SKILLS_INDEX_FILE}`,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!isNonNegativeInteger(value)) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
