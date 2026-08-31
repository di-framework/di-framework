import { useContainer } from '@di-framework/core/container';
import { Component } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  json,
  type PathParams,
  type QueryParams,
  type RequestSpec,
  type ResponseSpec,
} from '@di-framework/http';
import { normalizeDocsVersion } from '../docs-version';
import { router } from '../router';
import { SearchService } from '../services/SearchService';
import type { WritersideSearchResponse } from '../types';

type SearchPath = { project: string; instance: string; version?: string };
type SearchQuery = {
  query?: string;
  maxHits?: string;
  isExactSearch?: string;
  version?: string;
};

@Controller()
export class SearchController {
  constructor(@Component(SearchService) private readonly search: SearchService) {}

  async previewSearch(opts: {
    instance: string;
    query: string;
    maxHits: number;
    isExactSearch: boolean;
    version?: string;
    referer?: string | null;
  }): Promise<WritersideSearchResponse> {
    return this.search.search({
      query: opts.query,
      maxHits: opts.maxHits,
      isExactSearch: opts.isExactSearch,
      product: opts.instance || undefined,
      version: normalizeDocsVersion(opts.version, opts.referer),
    });
  }

  @Endpoint({
    summary: 'Writerside preview search',
    description:
      'Hybrid semantic + lexical search. Writerside calls `/preview-search/{project}/{instance}` or `/preview-search/{project}/{instance}/{version}`.',
    responses: {
      '200': { description: 'Algolia-shaped Writerside hits' },
    },
  })
  static get = router.get<
    RequestSpec<PathParams<SearchPath> & QueryParams<SearchQuery>>,
    ResponseSpec<WritersideSearchResponse>
  >('/preview-search/:project/:instance', async (req) => {
    const controller = useContainer().resolve(SearchController);
    const maxHits = Number(req.query.maxHits ?? '25');
    const body = await controller.previewSearch({
      instance: req.params.instance ?? '',
      query: req.query.query ?? '',
      maxHits: Number.isFinite(maxHits) ? maxHits : 25,
      isExactSearch: req.query.isExactSearch === 'true',
      version: req.query.version ?? req.params.version,
      referer: req.headers.get('referer') ?? req.headers.get('referrer'),
    });
    return json(body);
  });

  @Endpoint({
    summary: 'Writerside preview search (versioned)',
    description:
      'Same as `/preview-search/{project}/{instance}` but scoped to a docs snapshot (`latest` or `vMAJOR.MINOR`).',
    responses: {
      '200': { description: 'Algolia-shaped Writerside hits' },
    },
  })
  static getVersioned = router.get<
    RequestSpec<PathParams<SearchPath> & QueryParams<SearchQuery>>,
    ResponseSpec<WritersideSearchResponse>
  >('/preview-search/:project/:instance/:version', async (req) => {
    const controller = useContainer().resolve(SearchController);
    const maxHits = Number(req.query.maxHits ?? '25');
    const body = await controller.previewSearch({
      instance: req.params.instance ?? '',
      query: req.query.query ?? '',
      maxHits: Number.isFinite(maxHits) ? maxHits : 25,
      isExactSearch: req.query.isExactSearch === 'true',
      version: req.params.version ?? req.query.version,
      referer: req.headers.get('referer') ?? req.headers.get('referrer'),
    });
    return json(body);
  });
}
