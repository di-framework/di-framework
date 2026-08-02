import { Component, Container } from '@di-framework/core/decorators';
import type { Env } from '../env';
import type { DocPage } from '../models/DocPage';
import { contentHash } from './contentHash';
import { bagOfChars, EmbeddingService } from './EmbeddingService';

export type VectorMatch = {
  id: string;
  score: number;
  metadata?: Record<string, string>;
};

export type SyncResult = {
  /** Desired corpus size */
  total: number;
  /** Newly embedded or re-embedded */
  upserted: number;
  /** Removed from Vectorize (gone from corpus) */
  deleted: number;
  /** Unchanged — skipped (no AI call) */
  skipped: number;
  upsertedIds: string[];
  deletedIds: string[];
};

const MANIFEST_KEY = 'vector-manifest';

type Manifest = Record<string, string>; // id → contentHash

/**
 * Vectorize + Workers AI: upsert document embeddings and ANN-query them.
 *
 * Incremental sync (`sync`):
 * - content hash in a durable manifest (KV) + vector metadata
 * - only embed/upsert new or changed ids
 * - `deleteByIds` for ids that left the corpus
 *
 * Falls back to in-memory index + manifest when bindings are unbound (tests).
 */
@Container()
export class VectorIndexService {
  private memory = new Map<string, { values: number[]; metadata: Record<string, string> }>();
  private memoryManifest: Manifest = {};

  constructor(
    @Component('Env') private readonly getEnv: () => Env,
    @Component(EmbeddingService) private readonly embeddings: EmbeddingService,
  ) {}

  private env(): Env {
    return this.getEnv();
  }

  private hasVectorize(): boolean {
    return Boolean(this.env().VECTORIZE);
  }

  private hasStateKv(): boolean {
    return Boolean(this.env().INDEX_STATE);
  }

  async loadManifest(): Promise<Manifest> {
    if (this.hasStateKv()) {
      const raw = await this.env().INDEX_STATE!.get(MANIFEST_KEY);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as Manifest;
      } catch {
        return {};
      }
    }
    return { ...this.memoryManifest };
  }

  async saveManifest(manifest: Manifest): Promise<void> {
    if (this.hasStateKv()) {
      await this.env().INDEX_STATE!.put(MANIFEST_KEY, JSON.stringify(manifest));
    }
    this.memoryManifest = { ...manifest };
  }

  /**
   * Incremental reindex:
   * - upsert only pages whose content hash changed (or are new)
   * - delete vectors for ids no longer in `pages`
   * - skip unchanged (no Workers AI call)
   */
  async sync(pages: DocPage[], opts?: { full?: boolean }): Promise<SyncResult> {
    const prev = opts?.full ? {} : await this.loadManifest();
    const next: Manifest = {};
    const toUpsert: DocPage[] = [];

    const model = this.embeddings.model();
    for (const page of pages) {
      const hash = await contentHash(page, model);
      next[page.id] = hash;
      if (opts?.full || prev[page.id] !== hash) {
        toUpsert.push(page);
      }
    }

    const desiredIds = new Set(pages.map((p) => p.id));
    const deletedIds = Object.keys(prev).filter((id) => !desiredIds.has(id));

    if (deletedIds.length > 0) {
      await this.deleteByIds(deletedIds);
    }

    if (toUpsert.length > 0) {
      await this.upsertPages(toUpsert, next);
    }

    await this.saveManifest(next);

    return {
      total: pages.length,
      upserted: toUpsert.length,
      deleted: deletedIds.length,
      skipped: pages.length - toUpsert.length,
      upsertedIds: toUpsert.map((p) => p.id),
      deletedIds,
    };
  }

  /** Embed pages and upsert; metadata includes contentHash for debugging. */
  private async upsertPages(pages: DocPage[], hashes: Manifest): Promise<void> {
    const texts = pages.map((p) => `${p.pageTitle}\n${p.content}`.slice(0, 6000));
    const vectors = await this.embeddings.embed(texts);

    const rows = pages.map((page, i) => ({
      id: page.id,
      values: vectors[i] ?? bagOfChars(texts[i]!, 32),
      metadata: {
        product: page.product,
        version: page.version,
        pageTitle: page.pageTitle,
        contentHash: hashes[page.id] ?? '',
      },
    }));

    if (this.hasVectorize()) {
      const chunk = 50;
      for (let i = 0; i < rows.length; i += chunk) {
        await this.env().VECTORIZE.upsert(rows.slice(i, i + chunk));
      }
    } else {
      for (const row of rows) {
        this.memory.set(row.id, { values: row.values, metadata: row.metadata });
      }
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.hasVectorize()) {
      const chunk = 100;
      for (let i = 0; i < ids.length; i += chunk) {
        await this.env().VECTORIZE.deleteByIds(ids.slice(i, i + chunk));
      }
    } else {
      for (const id of ids) this.memory.delete(id);
    }
  }

  /**
   * Embed the query with Workers AI, then ANN-query Vectorize.
   */
  async query(queryText: string, opts: { topK: number; product?: string }): Promise<VectorMatch[]> {
    const vector = await this.embeddings.embedOne(queryText);
    const topK = Math.min(Math.max(opts.topK, 1), 50);

    if (this.hasVectorize()) {
      const result = await this.env().VECTORIZE.query(vector, {
        topK,
        returnMetadata: 'all',
        ...(opts.product ? { filter: { product: opts.product } } : {}),
      });
      return (result.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata as Record<string, string> | undefined,
      }));
    }

    const scored: VectorMatch[] = [];
    for (const [id, row] of this.memory) {
      if (opts.product && row.metadata.product !== opts.product) continue;
      scored.push({
        id,
        score: cosine(vector, row.values),
        metadata: row.metadata,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
