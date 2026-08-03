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
import { router } from '../router';
import { SearchService } from '../services/SearchService';
import type { WritersideSearchResponse } from '../types';

type SearchPath = { project: string; instance: string };
type SearchQuery = {
  query?: string;
  maxHits?: string;
  isExactSearch?: string;
};

@Controller()
export class SearchController {
  constructor(@Component(SearchService) private readonly search: SearchService) {}

  async previewSearch(opts: {
    instance: string;
    query: string;
    maxHits: number;
    isExactSearch: boolean;
  }): Promise<WritersideSearchResponse> {
    return this.search.search({
      query: opts.query,
      maxHits: opts.maxHits,
      isExactSearch: opts.isExactSearch,
      product: opts.instance || undefined,
    });
  }

  @Endpoint({
    summary: 'Writerside preview search',
    description:
      'Hybrid semantic + lexical search. Writerside calls `/preview-search/{project}/{instance}`.',
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
    });
    return json(body);
  });
}
