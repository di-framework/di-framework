import { Container } from '@di-framework/core/decorators';
import { type Derived, InMemoryRepository } from '@di-framework/repo';
import { DocPage } from '../models/DocPage';

/** Corpus JSON shape (Writerside topics / CI upload body). */
export type CorpusDoc = {
  objectID: string;
  url: string;
  pageTitle: string;
  mainTitle: string;
  breadcrumbs: string;
  content: string;
  product: string;
  version: string;
};

/**
 * In-memory document store with derived query methods from method names
 * (`findByProduct`, `findByPageTitleContaining`, …).
 */
@Container()
export class DocumentRepository extends InMemoryRepository<DocPage, string> {
  /** Seed from the prebuilt Writerside corpus (idempotent). */
  async seed(pages: DocPage[]): Promise<number> {
    let n = 0;
    for (const page of pages) {
      await this.save(page);
      n += 1;
    }
    return n;
  }

  async count(): Promise<number> {
    return (await this.findAll()).length;
  }

  /** Replace all metadata pages (e.g. CI corpus push) then reindex can sync vectors. */
  async replaceCorpus(docs: CorpusDoc[]): Promise<number> {
    const existing = await this.findAll();
    for (const page of existing) {
      await this.delete(page.id);
    }
    return this.seed(docs.map(corpusDocToPage));
  }
}

export function corpusDocToPage(d: CorpusDoc): DocPage {
  const page = new DocPage();
  page.id = d.objectID;
  page.url = d.url;
  page.pageTitle = d.pageTitle;
  page.mainTitle = d.mainTitle;
  page.breadcrumbs = d.breadcrumbs;
  page.content = d.content;
  page.product = d.product;
  page.version = d.version;
  return page;
}

/** Use this cast at call sites that need derived finder typings. */
export type Documents = Derived<DocumentRepository>;
