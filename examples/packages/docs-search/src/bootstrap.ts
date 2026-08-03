import { useContainer } from '@di-framework/core/container';
import corpus from '../data/corpus.json';
import { AuthController } from './controllers/AuthController';
import { HealthController } from './controllers/HealthController';
import { ReindexController } from './controllers/ReindexController';
import { SearchController } from './controllers/SearchController';
import type { Env } from './env';
import {
  type CorpusDoc,
  corpusDocToPage,
  DocumentRepository,
} from './repositories/DocumentRepository';
import { AuthService } from './services/AuthService';
import { EmbeddingService } from './services/EmbeddingService';
import { SearchService } from './services/SearchService';
import { VectorIndexService } from './services/VectorIndexService';

export type { CorpusDoc };

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

const DI_CLASSES = [
  DocumentRepository,
  EmbeddingService,
  VectorIndexService,
  SearchService,
  AuthService,
  HealthController,
  AuthController,
  SearchController,
  ReindexController,
] as const;

/**
 * Register services/controllers and load bundled Writerside corpus if the repo is empty.
 * CI replaces the corpus on each reindex via {@link DocumentRepository.replaceCorpus}.
 */
export async function bootstrap(): Promise<void> {
  const container = useContainer();

  if (!container.has('Env')) {
    container.registerFactory('Env', () => getEnv, { singleton: true });
  }

  for (const ctor of DI_CLASSES) {
    if (!container.has(ctor)) {
      container.register(ctor as new (...args: never[]) => unknown);
    }
  }

  const repo = container.resolve(DocumentRepository);
  if ((await repo.count()) === 0) {
    await repo.seed((corpus as { docs: CorpusDoc[] }).docs.map(corpusDocToPage));
  }
}
