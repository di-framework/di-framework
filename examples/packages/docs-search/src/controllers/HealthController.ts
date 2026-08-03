import { useContainer } from '@di-framework/core/container';
import { Component } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  json,
  type QueryParams,
  type RequestSpec,
  type ResponseSpec,
} from '@di-framework/http';
import type { Env } from '../env';
import { DocumentRepository } from '../repositories/DocumentRepository';
import { router } from '../router';

type HealthResponse = {
  service: string;
  showcase: string[];
  architecture: Record<string, string>;
  docsIndexed: number;
  writerside: { path: string; example: string };
  model: string;
  endpoints: Record<string, string>;
};

@Controller()
export class HealthController {
  constructor(
    @Component(DocumentRepository) private readonly documents: DocumentRepository,
    @Component('Env') private readonly getEnv: () => Env,
  ) {}

  async health(): Promise<HealthResponse> {
    const env = this.getEnv();
    const docs = await this.documents.count();
    return {
      service: 'di-framework-docs-search',
      showcase: [
        '@di-framework/core',
        '@di-framework/repo',
        '@di-framework/http',
        'Workers AI',
        'Vectorize',
      ],
      architecture: {
        http: 'HealthController / AuthController / SearchController / ReindexController',
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
    };
  }

  @Endpoint({
    summary: 'Service health / discovery',
    description: 'Returns indexed doc count, architecture notes, and Writerside endpoint hints.',
    responses: {
      '200': { description: 'Service metadata' },
    },
  })
  static get = router.get<
    RequestSpec<QueryParams<Record<string, never>>>,
    ResponseSpec<HealthResponse>
  >('/', async () => {
    const controller = useContainer().resolve(HealthController);
    return json(await controller.health());
  });
}
