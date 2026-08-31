import { Component, Container } from '@di-framework/core/decorators';
import type { DocPage } from '../models/DocPage';
import { DocumentRepository } from '../repositories/DocumentRepository';
import type { ScoredDoc, WritersideHit, WritersideSearchResponse } from '../types';
import { VectorIndexService } from './VectorIndexService';

/**
 * Hybrid search for Writerside:
 * 1. Workers AI embeds the query
 * 2. Vectorize ANN returns top vector ids + scores
 * 3. DocumentRepository hydrates DocPage metadata (snippets, titles, urls)
 * 4. Optional lexical boost for exact token matches
 */
@Container()
export class SearchService {
  constructor(
    @Component(VectorIndexService) private readonly vectors: VectorIndexService,
    @Component(DocumentRepository) private readonly documents: DocumentRepository,
  ) {}

  async search(opts: {
    query: string;
    maxHits?: number;
    isExactSearch?: boolean;
    product?: string;
    version?: string;
  }): Promise<WritersideSearchResponse> {
    const query = opts.query.trim();
    const maxHits = Math.min(Math.max(opts.maxHits ?? 25, 1), 50);
    const queryID = crypto.randomUUID();

    if (!query) {
      return emptyResponse(query, maxHits, queryID);
    }

    const tokens = tokenize(query, opts.isExactSearch);
    const version = opts.version || 'latest';
    // Over-fetch a bit so lexical re-rank has room
    const matches = await this.vectors.query(query, {
      topK: Math.min(maxHits * 2, 50),
      product: opts.product,
      version,
    });

    const scored: ScoredDoc[] = [];
    for (const match of matches) {
      const page = await this.documents.findById(match.id);
      if (!page) continue;
      if (page.version !== version) continue;

      if (opts.isExactSearch && tokens[0]) {
        const hay = `${page.pageTitle} ${page.content}`.toLowerCase();
        if (!hay.includes(tokens[0])) continue;
      }

      const lexical = lexicalScore(page, tokens, opts.isExactSearch);
      // Vectorize cosine scores are typically ~0.5–1 for related docs
      const semantic = Math.max(0, match.score);
      const score = 0.35 * lexical + 0.65 * semantic;
      if (score <= 0 && semantic < 0.3) continue;

      scored.push({
        doc: { ...page, objectID: page.id },
        score,
        matchedWords: tokens.filter((t) =>
          `${page.pageTitle} ${page.content}`.toLowerCase().includes(t),
        ),
        snippet: makeSnippet(page.content, tokens),
      });
    }

    // If Vectorize is empty (fresh deploy), fall back to pure lexical via repo
    if (scored.length === 0) {
      const pages = await this.documents.findAll();
      for (const page of pages) {
        if (opts.product && page.product !== opts.product) continue;
        if (page.version !== version) continue;
        const lexical = lexicalScore(page, tokens, opts.isExactSearch);
        if (lexical <= 0) continue;
        scored.push({
          doc: { ...page, objectID: page.id },
          score: lexical,
          matchedWords: tokens.filter((t) =>
            `${page.pageTitle} ${page.content}`.toLowerCase().includes(t),
          ),
          snippet: makeSnippet(page.content, tokens),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxHits);
    const hits = top.map((s) => toHit(s));

    return {
      hits,
      nbHits: hits.length,
      page: 0,
      nbPages: hits.length > 0 ? 1 : 0,
      hitsPerPage: maxHits,
      query,
      queryID,
    };
  }

  /**
   * Incremental index sync (default):
   * - embed/upsert only new or changed pages (content hash)
   * - delete Vectorize ids removed from the corpus
   * - skip unchanged (no AI cost)
   *
   * Pass `{ full: true }` to rebuild every vector.
   */
  async reindex(opts?: { full?: boolean }) {
    const pages = await this.documents.findAll();
    return this.vectors.sync(pages, opts);
  }
}

function emptyResponse(query: string, maxHits: number, queryID: string): WritersideSearchResponse {
  return {
    hits: [],
    nbHits: 0,
    page: 0,
    nbPages: 0,
    hitsPerPage: maxHits,
    query,
    queryID,
  };
}

export function tokenize(query: string, exact?: boolean): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  if (exact) return [q];
  return q.split(/[^a-z0-9@/+_-]+/i).filter((t) => t.length > 1);
}

export function lexicalScore(doc: DocPage, tokens: string[], exact?: boolean): number {
  if (tokens.length === 0) return 0;
  const title = doc.pageTitle.toLowerCase();
  const body = doc.content.toLowerCase();
  const hay = `${title} ${body}`;

  if (exact) {
    return hay.includes(tokens[0]!) ? 1 : 0;
  }

  let hits = 0;
  let titleHits = 0;
  for (const t of tokens) {
    if (title.includes(t)) {
      hits += 1;
      titleHits += 1;
    } else if (body.includes(t)) {
      hits += 1;
    }
  }
  const coverage = hits / tokens.length;
  return coverage * 0.7 + (titleHits / tokens.length) * 0.3;
}

export function makeSnippet(content: string, tokens: string[], width = 160): string {
  const lower = content.toLowerCase();
  let idx = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  const start = Math.max(0, idx - 40);
  const slice = content.slice(start, start + width).trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + width < content.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

function matchLevel(text: string, tokens: string[]): 'none' | 'partial' | 'full' {
  if (tokens.length === 0) return 'none';
  const lower = text.toLowerCase();
  const n = tokens.filter((t) => lower.includes(t)).length;
  if (n === 0) return 'none';
  if (n === tokens.length) return 'full';
  return 'partial';
}

function toHit(s: ScoredDoc): WritersideHit {
  const { doc, matchedWords, snippet } = s;
  const contentLevel = matchLevel(doc.content, matchedWords);
  const titleLevel = matchLevel(doc.pageTitle, matchedWords);
  return {
    url: doc.url,
    pageTitle: doc.pageTitle,
    breadcrumbs: doc.breadcrumbs,
    mainTitle: doc.mainTitle,
    objectID: doc.id,
    _snippetResult: {
      content: { value: snippet, matchLevel: contentLevel },
    },
    _highlightResult: {
      headings: {
        value: doc.pageTitle,
        matchLevel: titleLevel,
        matchedWords,
      },
      content: {
        value: snippet,
        matchLevel: contentLevel,
        fullyHighlighted: false,
        matchedWords,
      },
      pageTitle: {
        value: doc.pageTitle,
        matchLevel: titleLevel,
        matchedWords,
      },
      metaDescription: { value: '', matchLevel: 'none', matchedWords: [] },
      breadcrumbs: {
        value: doc.breadcrumbs,
        matchLevel: matchLevel(doc.breadcrumbs, matchedWords),
        matchedWords,
      },
      mainTitle: {
        value: doc.mainTitle,
        matchLevel: titleLevel,
        matchedWords,
      },
    },
  };
}
