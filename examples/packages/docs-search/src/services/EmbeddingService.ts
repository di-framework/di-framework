import { Component, Container } from '@di-framework/core/decorators';
import type { Env } from '../env';

/** Default: Google EmbeddingGemma 300M → 768-d (same width as BGE base). */
export const DEFAULT_EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m';

/**
 * Thin wrapper around the Workers AI binding for text embeddings.
 * Model via `EMBEDDING_MODEL` (default EmbeddingGemma 300M, 768-d).
 */
@Container()
export class EmbeddingService {
  constructor(@Component('Env') private readonly getEnv: () => Env) {}

  private env(): Env {
    return this.getEnv();
  }

  model(): string {
    return this.env().EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  }

  async embed(texts: string | string[]): Promise<number[][]> {
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length === 0) return [];

    const ai = this.env().AI;
    if (!ai) {
      // Local tests / missing binding — deterministic pseudo-embedding
      return input.map((t) => bagOfChars(t, 32));
    }

    const result = (await ai.run(this.model() as Parameters<Ai['run']>[0], {
      text: input,
    })) as { data?: number[][] };

    if (!result?.data || result.data.length !== input.length) {
      throw new Error('Workers AI embedding response missing data[]');
    }
    return result.data;
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed(text);
    return v ?? bagOfChars(text, 32);
  }
}

/** Tiny fallback for unit tests without the AI binding. */
export function bagOfChars(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const s = text.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    v[s.charCodeAt(i) % dims]! += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
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
