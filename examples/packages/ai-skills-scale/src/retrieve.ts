import { existsSync } from 'node:fs';
import {
  loadSkillsIndex,
  searchSkillsIndex,
  TransformersJsSkillEmbedder,
} from '@di-framework/ai-utils';
import { defaultIndexFile } from './build-index.ts';
import { retrievalCases } from './retrieval-cases.ts';

export async function runRetrievalBenchmark(indexFile = defaultIndexFile): Promise<void> {
  if (!existsSync(indexFile)) {
    throw new Error('Skills index is missing. Run `bun run index` first.');
  }
  const index = loadSkillsIndex(indexFile);
  if (!index.metadata.indexed) {
    console.log(
      `Catalog has ${index.metadata.skillCount} skills, at or below threshold ${index.metadata.threshold}; semantic retrieval is disabled.`,
    );
    return;
  }

  const embedder = new TransformersJsSkillEmbedder({
    model: index.metadata.model,
    revision: index.metadata.revision,
  });
  console.log(
    `index: ${index.metadata.skillCount} skills, ${index.metadata.dimensions} dimensions`,
  );
  console.log(`case\texpected\trank\ttop ${index.metadata.retrievalLimit}`);
  const ranks: number[] = [];
  for (const selectionCase of retrievalCases) {
    const ranked = await searchSkillsIndex(index, selectionCase.prompt, {
      embedder,
      limit: index.entries.length,
    });
    const rank = ranked.findIndex((match) => match.name === selectionCase.expectedSkill) + 1;
    ranks.push(rank || Number.POSITIVE_INFINITY);
    console.log(
      [
        selectionCase.id,
        selectionCase.expectedSkill,
        rank || '(missing)',
        ranked
          .slice(0, index.metadata.retrievalLimit)
          .map((match) => `${match.name} (${match.score.toFixed(3)})`)
          .join(', '),
      ].join('\t'),
    );
  }
  const recall = (limit: number) => ranks.filter((rank) => rank <= limit).length;
  const reciprocalRank =
    ranks.reduce((sum, rank) => sum + (Number.isFinite(rank) ? 1 / rank : 0), 0) / ranks.length;
  console.log(
    `recall@1 ${recall(1)}/${ranks.length}; recall@5 ${recall(5)}/${ranks.length}; recall@10 ${recall(10)}/${ranks.length}; MRR ${reciprocalRank.toFixed(4)}`,
  );
}

export async function runRetrieveMain(isMain = import.meta.main): Promise<void> {
  if (!isMain) return;
  await runRetrievalBenchmark();
}

await runRetrieveMain();
