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
 * Without Vectorize (unit tests): skip remote upsert/delete; keep a local
 * content-hash manifest only. Query returns [] → SearchService lexical fallback.
 */
@Container()
export class VectorIndexService {
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
      const raw = await this.env().INDEX_STATE?.get(MANIFEST_KEY);
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
      await this.env().INDEX_STATE?.put(MANIFEST_KEY, JSON.stringify(manifest));
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

    if (!this.hasVectorize()) return;

    const chunk = 50;
    for (let i = 0; i < rows.length; i += chunk) {
      await this.env().VECTORIZE.upsert(rows.slice(i, i + chunk));
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0 || !this.hasVectorize()) return;
    const chunk = 100;
    for (let i = 0; i < ids.length; i += chunk) {
      await this.env().VECTORIZE.deleteByIds(ids.slice(i, i + chunk));
    }
  }

  /**
   * Embed the query with Workers AI, then ANN-query Vectorize (cosine metric).
   * Without Vectorize, returns [] so SearchService uses lexical fallback.
   */
  async query(
    queryText: string,
    opts: { topK: number; product?: string; version?: string },
  ): Promise<VectorMatch[]> {
    if (!this.hasVectorize()) {
      return [];
    }

    const vector = await this.embeddings.embedOne(queryText);
    const topK = Math.min(Math.max(opts.topK, 1), 50);
    const filter: Record<string, string> = {};
    if (opts.product) filter.product = opts.product;
    if (opts.version) filter.version = opts.version;
    const result = await this.env().VECTORIZE.query(vector, {
      topK,
      returnMetadata: 'all',
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    });
    return (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata as Record<string, string> | undefined,
    }));
  }
}
