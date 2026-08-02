/**
 * Cloudflare bindings + vars for the docs search worker.
 * @see wrangler.jsonc
 *
 * Auth: no Cloudflare API tokens in GitHub. CI uses GitHub Actions OIDC;
 * the worker verifies OIDC and can mint short-lived reindex JWTs.
 */
export interface Env {
  /** Workers AI — embed queries and documents (default EmbeddingGemma 300M → 768-d). */
  AI: Ai;
  /**
   * Vectorize index (cosine, 768 dims) for ANN retrieval.
   * Create: `wrangler vectorize create di-docs-search --dimensions=768 --metric=cosine`
   */
  VECTORIZE: VectorizeIndex;
  /**
   * Durable id → contentHash manifest for incremental sync.
   * Create: `wrangler kv namespace create INDEX_STATE`
   */
  INDEX_STATE?: KVNamespace;

  DOCS_BASE_URL: string;
  /** e.g. @cf/google/embeddinggemma-300m */
  EMBEDDING_MODEL: string;
  /** Comma-separated browser origins */
  CORS_ORIGINS: string;
  /**
   * URL path prefix when mounted on di-framework.dev
   * (e.g. `/api/docs/search`). Empty when using a bare workers.dev host.
   */
  BASE_PATH?: string;

  /**
   * HS256 secret for minting/verifying reindex tokens.
   * Set once: `wrangler secret put TOKEN_SIGNING_KEY` (never put in GitHub).
   */
  TOKEN_SIGNING_KEY: string;

  /** OIDC audience GitHub Actions must request (default di-framework-docs-search). */
  GITHUB_OIDC_AUDIENCE: string;
  /** Allowed `repository` claim (default di-framework/di-framework). */
  GITHUB_REPOSITORY: string;
  /** If not "false", require ref == refs/heads/main. */
  GITHUB_OIDC_REQUIRE_MAIN?: string;
  /** Reindex token TTL seconds (default 600). */
  REINDEX_TOKEN_TTL_SECONDS?: string;
}
