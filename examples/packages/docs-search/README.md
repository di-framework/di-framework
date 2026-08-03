# Docs search Worker (showcase)

**Writerside-compatible documentation search** on Cloudflare Workers — dogfood for:

| Piece | Role |
| --- | --- |
| `@di-framework/core` | Container, `@Container` / `@Component` |
| `@di-framework/http` | `@Controller` / `@Endpoint`, `TypedRouter` (HTTP API) |
| `@di-framework/repo` | `@Model` / `@Id`, `InMemoryRepository` for **document metadata** |
| **Workers AI** | Embed queries + pages (`@cf/google/embeddinggemma-300m`, 768-d) |
| **Vectorize** | Cosine ANN index of those vectors |

```
HTTP (Controller)
  → Service (search / auth / embeddings / vectors)
  → DocumentRepository (metadata)
  → Workers AI + Vectorize
```

Vectors are **not** stored on entities — metadata in repo, vectors in Vectorize (same `id`).

## One-time Cloudflare setup

```bash
# 768 dims must match EmbeddingGemma 300M (same width as BGE base)
wrangler vectorize create di-docs-search --dimensions=768 --metric=cosine
```

`wrangler.jsonc` already binds:

- `AI` → Workers AI (`EMBEDDING_MODEL`: `@cf/google/embeddinggemma-300m`)
- `VECTORIZE` → index `di-docs-search`

If you previously indexed with another model, run a full reindex (or rely on
content hashes that include the model id — incremental sync will re-upsert all):

```bash
curl -X POST 'https://…/reindex?full=1'
```

## Quick start

```bash
cd examples/packages/docs-search
bun install
bun run corpus
bun test
bun run dev
```

```bash
# seed vectors (after deploy or in dev with bindings)
curl -X POST http://127.0.0.1:8787/reindex

curl 'http://127.0.0.1:8787/preview-search/docs/d?query=repository'
curl http://127.0.0.1:8787/
```

## Deploy

### Auth model (no Cloudflare API tokens in GitHub)

CI never sees Cloudflare credentials. Flow:

```
GitHub Actions OIDC JWT
  → POST /auth/token  (worker verifies GitHub JWKS)
  → short-lived reindex JWT (signed by TOKEN_SIGNING_KEY on the Worker)
  → POST /reindex + corpus.json body
```

Worker is deployed **from your machine** (`wrangler deploy`); CI only rebuilds
the corpus and asks the Worker to reindex.

### One-time Worker setup (local)

```bash
wrangler vectorize create di-docs-search --dimensions=768 --metric=cosine
wrangler kv namespace create INDEX_STATE   # paste id into wrangler.jsonc
# random secret — stays on Cloudflare only
openssl rand -base64 48 | wrangler secret put TOKEN_SIGNING_KEY

bun run deploy
```

### CI

[`.github/workflows/deploy-docs.yml`](../../../.github/workflows/deploy-docs.yml):

1. `bun run corpus`
2. Request GitHub OIDC (`audience=di-framework-docs-search`)
3. `POST /auth/token` → reindex JWT  
4. `POST /reindex` with corpus JSON + Bearer token  
5. Build + deploy GitHub Pages  

**Domains**

| Host | Role |
| --- | --- |
| `https://docs.di-framework.dev` | Writerside site (GitHub Pages custom domain) |
| `https://di-framework-docs-search.seemueller.workers.dev/api/docs/search` | Search Worker (public `workers.dev` URL) |
| `https://di-framework.dev/api/docs/search` | Same Worker via apex route (when apex DNS is healthy) |

| Worker path | Role |
| --- | --- |
| `/` (under base) | Health |
| `/auth/token` | OIDC → reindex JWT |
| `/reindex` | Push corpus + Vectorize sync |
| `/preview-search/{project}/{instance}` | Writerside search API |

GitHub optional override: variable `DOCS_SEARCH_URL` (defaults to the URL above).  
Permissions: `id-token: write` only. No `CLOUDFLARE_*` secrets.

Workflow dispatch has **full_reindex** → `POST …/reindex?full=1`.

### Manual reindex (with a token)

```bash
WORKER=https://di-framework-docs-search.seemueller.workers.dev/api/docs/search
curl -X POST "$WORKER/reindex" \
  -H "Authorization: Bearer $REINDEX_JWT" \
  -H "Content-Type: application/json" \
  --data-binary @data/corpus.json
```

Writerside (`buildprofiles.xml`):

```xml
<search-endpoint>https://di-framework-docs-search.seemueller.workers.dev/api/docs/search</search-endpoint>
```

Writerside calls `{search-endpoint}/preview-search/{project}/{instance}`.

## Architecture

Controller → Service → Repo:

| Layer | Where |
| --- | --- |
| HTTP | `HealthController`, `AuthController`, `SearchController`, `ReindexController` (`@di-framework/http`) |
| Auth | `AuthService` → `auth.ts` (OIDC / reindex JWT) |
| Search | `SearchService` (hybrid rank + Writerside DTO) |
| Embeddings | `EmbeddingService` → `env.AI` |
| Vectors | `VectorIndexService` → `env.VECTORIZE` |
| Metadata | `DocPage` + `DocumentRepository` |

## Incremental index sync

`POST /reindex` is **incremental** by default:

| Case | Action |
| --- | --- |
| New topic | embed + Vectorize `upsert` |
| Edited topic (title/body hash changed) | re-embed + `upsert` |
| Unchanged | **skip** (no AI call) |
| Removed from corpus | Vectorize `deleteByIds` |

How it works:

1. SHA-256 of `pageTitle + content` per doc.
2. Durable manifest `id → hash` in **KV** `INDEX_STATE` (in-memory fallback in tests).
3. Diff against previous manifest → upsert / delete / skip.
4. Hash also stored on vector **metadata** (`contentHash`) for debugging.

```bash
# incremental (cheap)
curl -X POST https://…/reindex

# force full rebuild
curl -X POST 'https://…/reindex?full=1'
```

Wire KV (recommended in production so deletes survive isolate restarts):

```bash
wrangler kv namespace create INDEX_STATE
# paste id into wrangler.jsonc kv_namespaces
```

Corpus flow on each deploy:

```bash
bun run corpus          # rebuild data/corpus.json from Writerside topics
bun run deploy
curl -X POST …/reindex  # only embeds what changed
```

## Why this shape?

- **AI + Vectorize** is the Cloudflare-native semantic search stack.
- **Repo** keeps metadata typed, injectable, and swappable (KV/D1 adapter later) without stuffing 768 floats onto every entity.
- **Incremental sync** keeps AI cost proportional to docs that actually changed.
- **Showcase**: core, http, repo, AI, Vectorize, and KV end-to-end with a clear Controller → Service → Repo split.
