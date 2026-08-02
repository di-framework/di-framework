/** One searchable unit (usually one Writerside topic). */
export type DocRecord = {
  objectID: string;
  url: string;
  pageTitle: string;
  mainTitle: string;
  breadcrumbs: string;
  content: string;
  product: string;
  version: string;
};

export type Corpus = {
  generatedAt: string;
  docs: DocRecord[];
};

/** Writerside custom search service response (Algolia-shaped). */
export type WritersideHit = {
  url: string;
  pageTitle: string;
  breadcrumbs: string;
  mainTitle: string;
  objectID: string;
  _snippetResult: {
    content: { value: string; matchLevel: 'none' | 'partial' | 'full' };
  };
  _highlightResult: {
    headings: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      matchedWords: string[];
    };
    content: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      fullyHighlighted: boolean;
      matchedWords: string[];
    };
    pageTitle: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      matchedWords: string[];
    };
    metaDescription: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      matchedWords: string[];
    };
    breadcrumbs: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      matchedWords: string[];
    };
    mainTitle: {
      value: string;
      matchLevel: 'none' | 'partial' | 'full';
      matchedWords: string[];
    };
  };
};

export type WritersideSearchResponse = {
  hits: WritersideHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  query: string;
  queryID: string;
};

export type ScoredDoc = {
  /** Repo entity (DocPage) at runtime; DocRecord is the corpus JSON shape. */
  doc: DocRecord & { id: string; embedding?: number[] };
  score: number;
  matchedWords: string[];
  snippet: string;
};
