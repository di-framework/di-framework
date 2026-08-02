import { useContainer } from '@di-framework/core/container';
import corpus from '../data/corpus.json';
import type { Env } from './env';
import { DocPage } from './models/DocPage';
import { DocumentRepository } from './repositories/DocumentRepository';
import { EmbeddingService } from './services/EmbeddingService';
import { SearchService } from './services/SearchService';
import { VectorIndexService } from './services/VectorIndexService';

/** Per-isolate env holder so DI can inject a stable `Env` factory. */
let currentEnv: Env | null = null;

export function bindEnv(env: Env): void {
  currentEnv = env;
}

export function getEnv(): Env {
  if (!currentEnv) {
    throw new Error('Env not bound — call bindEnv(env) at the start of fetch');
  }
  return currentEnv;
}

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

let seeded = false;

/**
 * Register services and load bundled Writerside corpus if the repo is empty.
 * CI replaces the corpus on each reindex via {@link replaceCorpus}.
 */
export async function bootstrap(): Promise<void> {
  const container = useContainer();

  if (!container.has('Env')) {
    container.registerFactory('Env', () => getEnv, { singleton: true });
  }

  void EmbeddingService;
  void VectorIndexService;
  void SearchService;
  void DocumentRepository;

  if (!seeded) {
    const repo = container.resolve(DocumentRepository);
    if ((await repo.count()) === 0) {
      await seedFromDocs((corpus as { docs: CorpusDoc[] }).docs);
    }
    seeded = true;
  }
}

function toPage(d: CorpusDoc): DocPage {
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

async function seedFromDocs(docs: CorpusDoc[]): Promise<number> {
  const repo = useContainer().resolve(DocumentRepository);
  return repo.seed(docs.map(toPage));
}

/** Replace metadata corpus (e.g. body from CI) then reindex can sync vectors. */
export async function replaceCorpus(docs: CorpusDoc[]): Promise<number> {
  const repo = useContainer().resolve(DocumentRepository);
  const existing = await repo.findAll();
  for (const page of existing) {
    await repo.delete(page.id);
  }
  return seedFromDocs(docs);
}

export function resolveSearch(): SearchService {
  return useContainer().resolve(SearchService);
}

export function resolveDocuments(): DocumentRepository {
  return useContainer().resolve(DocumentRepository);
}
