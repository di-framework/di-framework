import { authorizeReindex, issueReindexToken, verifyGitHubOidc } from './auth';
import {
  bindEnv,
  bootstrap,
  type CorpusDoc,
  replaceCorpus,
  resolveDocuments,
  resolveSearch,
} from './bootstrap';
import type { Env } from './env';

const PREVIEW_SEARCH = /^\/preview-search\/([^/]+)\/([^/]+)\/?$/;

/** Strip mount path on di-framework.dev (e.g. /api/docs/search). */
function appPath(pathname: string, env: Env): string {
  const base = (env.BASE_PATH || '').replace(/\/$/, '');
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
    const rest = pathname.slice(base.length) || '/';
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname;
}

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  bindEnv(env);
  await bootstrap();

  const url = new URL(request.url);
  const path = appPath(url.pathname, env);
  const cors = corsHeaders(env, request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (path === '/' && request.method === 'GET') {
    const docs = await resolveDocuments().count();
    return json(
      {
        service: 'di-framework-docs-search',
        showcase: ['@di-framework/core', '@di-framework/repo', 'Workers AI', 'Vectorize'],
        architecture: {
          metadata: 'DocumentRepository (InMemoryRepository)',
          embeddings: 'env.AI → EmbeddingGemma (768-d)',
          vectors: 'env.VECTORIZE (cosine ANN)',
          auth: 'GitHub OIDC → worker-minted reindex JWT (no CF API tokens in CI)',
        },
        docsIndexed: docs,
        writerside: {
          path: '/preview-search/{project}/{instance}?query=…',
          example: '/preview-search/docs/d?query=repository&maxHits=10',
        },
        model: env.EMBEDDING_MODEL || '@cf/google/embeddinggemma-300m',
        endpoints: {
          token: 'POST /auth/token — exchange GitHub OIDC for reindex JWT',
          reindex: 'POST /reindex — Bearer reindex JWT or GitHub OIDC; body optional corpus JSON',
        },
      },
      cors,
    );
  }

  // Exchange GitHub Actions OIDC for a short-lived reindex token (minted here)
  if (path === '/auth/token' && request.method === 'POST') {
    const header = request.headers.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m?.[1]) {
      return json({ error: 'Bearer GitHub OIDC token required' }, cors, 401);
    }
    const oidc = await verifyGitHubOidc(m[1].trim(), env);
    if (!oidc.ok) {
      return json({ error: oidc.error }, cors, oidc.status);
    }
    try {
      const issued = await issueReindexToken(env, {
        sub: oidc.subject,
        via: 'github-oidc',
      });
      return json(
        {
          token_type: 'Bearer',
          access_token: issued.token,
          expires_in: issued.expiresIn,
          expires_at: issued.expiresAt,
          scope: 'reindex',
        },
        cors,
      );
    } catch (err) {
      return json(
        {
          error: err instanceof Error ? err.message : 'Failed to mint token',
        },
        cors,
        500,
      );
    }
  }

  if (path === '/reindex' && request.method === 'POST') {
    const auth = await authorizeReindex(request, env);
    if (!auth.ok) {
      return json({ error: auth.error }, cors, auth.status);
    }

    const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true';

    // Optional body: { docs: CorpusDoc[] } or full corpus.json { generatedAt, docs }
    let corpusReplaced = 0;
    const raw = await request.text();
    if (raw.trim()) {
      try {
        const body = JSON.parse(raw) as {
          docs?: CorpusDoc[];
          generatedAt?: string;
        };
        const docs = body.docs;
        if (!Array.isArray(docs) || docs.length === 0) {
          return json({ error: 'body.docs must be a non-empty array' }, cors, 400);
        }
        corpusReplaced = await replaceCorpus(docs);
      } catch {
        return json({ error: 'Invalid JSON body' }, cors, 400);
      }
    }

    const result = await resolveSearch().reindex({ full });
    return json(
      {
        ok: true,
        mode: full ? 'full' : 'incremental',
        auth: auth.via,
        subject: auth.subject,
        corpusReplaced,
        ...result,
      },
      cors,
    );
  }

  const m = path.match(PREVIEW_SEARCH);
  if (m && request.method === 'GET') {
    const instance = m[2]!;
    const query = url.searchParams.get('query') ?? '';
    const maxHits = Number(url.searchParams.get('maxHits') ?? '25');
    const isExactSearch = url.searchParams.get('isExactSearch') === 'true';

    const body = await resolveSearch().search({
      query,
      maxHits: Number.isFinite(maxHits) ? maxHits : 25,
      isExactSearch,
      product: instance || undefined,
    });
    return json(body, cors);
  }

  return json({ error: 'Not found' }, cors, 404);
}

function corsHeaders(env: Env, request: Request): HeadersInit {
  const allowed = (env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  const allow =
    allowed.includes('*') || allowed.includes(origin) ? origin || '*' : allowed[0] || '*';

  return {
    'access-control-allow-origin': allow || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

function json(data: unknown, cors: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...cors,
    },
  });
}
