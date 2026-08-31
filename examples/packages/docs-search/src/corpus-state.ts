import type { Env } from './env';
import type { CorpusDoc, DocumentRepository } from './repositories/DocumentRepository';

const CORPUS_KV_KEY = 'corpus-docs';

export async function persistCorpus(env: Env, documents: DocumentRepository): Promise<void> {
  const kv = env.INDEX_STATE;
  if (!kv) return;
  const docs = await documents.toCorpusDocs();
  await kv.put(CORPUS_KV_KEY, JSON.stringify(docs));
}

export async function hydrateCorpus(env: Env, documents: DocumentRepository): Promise<boolean> {
  const kv = env.INDEX_STATE;
  if (!kv) return false;
  const raw = await kv.get(CORPUS_KV_KEY);
  if (!raw) return false;
  try {
    const docs = JSON.parse(raw) as CorpusDoc[];
    if (!Array.isArray(docs) || docs.length === 0) return false;
    await documents.replaceCorpus(docs);
    return true;
  } catch {
    return false;
  }
}
