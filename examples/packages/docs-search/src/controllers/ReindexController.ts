import { useContainer } from '@di-framework/core/container';
import { Component } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  type Json,
  json,
  type QueryParams,
  type RequestSpec,
  type ResponseSpec,
} from '@di-framework/http';
import { type CorpusDoc, DocumentRepository } from '../repositories/DocumentRepository';
import { router } from '../router';
import { AuthService } from '../services/AuthService';
import { SearchService } from '../services/SearchService';
import type { SyncResult } from '../services/VectorIndexService';

type ReindexBody = {
  docs?: CorpusDoc[];
  generatedAt?: string;
};

type ReindexQuery = {
  full?: string;
};

type ReindexResponse = SyncResult & {
  ok: true;
  mode: 'full' | 'incremental';
  auth: 'github-oidc' | 'reindex-token';
  subject: string;
  corpusReplaced: number;
};

type ErrorBody = { error: string };

@Controller()
export class ReindexController {
  constructor(
    @Component(AuthService) private readonly auth: AuthService,
    @Component(SearchService) private readonly search: SearchService,
    @Component(DocumentRepository) private readonly documents: DocumentRepository,
  ) {}

  async reindex(
    request: Request,
    opts: { full: boolean; body?: ReindexBody | null },
  ): Promise<{ ok: true; body: ReindexResponse } | { ok: false; status: number; error: string }> {
    const auth = await this.auth.authorizeReindex(request);
    if (!auth.ok) {
      return { ok: false, status: auth.status, error: auth.error };
    }

    let corpusReplaced = 0;
    if (opts.body != null) {
      const docs = opts.body.docs;
      if (!Array.isArray(docs) || docs.length === 0) {
        return { ok: false, status: 400, error: 'body.docs must be a non-empty array' };
      }
      corpusReplaced = await this.documents.replaceCorpus(docs);
    }

    const result = await this.search.reindex({ full: opts.full });
    return {
      ok: true,
      body: {
        ok: true,
        mode: opts.full ? 'full' : 'incremental',
        auth: auth.via,
        subject: auth.subject,
        corpusReplaced,
        ...result,
      },
    };
  }

  @Endpoint({
    summary: 'Reindex corpus + Vectorize',
    description:
      'Optional JSON body `{ docs }` replaces the in-memory corpus. Then syncs Vectorize (incremental unless `?full=1`).',
    responses: {
      '200': { description: 'Sync result' },
      '400': { description: 'Invalid corpus body' },
      '401': { description: 'Missing or invalid auth' },
      '403': { description: 'Auth claims not allowed' },
    },
  })
  static post = router.post<
    RequestSpec<Json<ReindexBody> & QueryParams<ReindexQuery>>,
    ResponseSpec<ReindexResponse | ErrorBody>
  >('/reindex', async (req) => {
    const controller = useContainer().resolve(ReindexController);
    const full = req.query.full === '1' || req.query.full === 'true';
    const raw = req.content;
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
      return json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const body = (raw ?? null) as ReindexBody | null;
    const result = await controller.reindex(req as unknown as Request, { full, body });
    if (!result.ok) {
      return json({ error: result.error }, { status: result.status });
    }
    return json(result.body);
  });
}
