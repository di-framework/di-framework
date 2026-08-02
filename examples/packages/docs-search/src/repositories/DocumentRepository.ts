import { Container } from '@di-framework/core/decorators';
import { type Derived, InMemoryRepository } from '@di-framework/repo';
import type { DocPage } from '../models/DocPage';

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
}

/** Use this cast at call sites that need derived finder typings. */
export type Documents = Derived<DocumentRepository>;
