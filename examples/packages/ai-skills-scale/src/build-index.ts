import { existsSync, statSync } from 'node:fs';
import {
  DEFAULT_SKILLS_INDEX_THRESHOLD,
  DEFAULT_SKILLS_RETRIEVAL_LIMIT,
  SkillsIndex,
} from '@di-framework/ai-utils';
import { defaultIndexFile, defaultSkillsDirectory, loadSkillCorpus } from './corpus.ts';

export { defaultIndexFile } from './corpus.ts';

export async function buildScaleSkillsIndex(
  options: {
    skillsDirectory?: string;
    outputFile?: string;
    threshold?: number;
    ifPresent?: boolean;
  } = {},
): Promise<void> {
  const skillsDirectory = options.skillsDirectory ?? defaultSkillsDirectory;
  if (!existsSync(skillsDirectory)) {
    if (options.ifPresent) {
      console.log('Skill corpus is not fetched; skipping the optional semantic index build.');
      return;
    }
    throw new Error('Skill corpus is missing. Run `bun run fetch` first.');
  }

  const corpus = loadSkillCorpus(skillsDirectory);
  const started = performance.now();
  let lastReported = 0;
  const result = await SkillsIndex.builder()
    .addSkills(corpus.skills)
    .outputFile(options.outputFile ?? defaultIndexFile)
    .threshold(options.threshold ?? DEFAULT_SKILLS_INDEX_THRESHOLD)
    .retrievalLimit(DEFAULT_SKILLS_RETRIEVAL_LIMIT)
    .onProgress((completed, total) => {
      if (completed === total || completed - lastReported >= 256) {
        console.log(`embedded ${completed}/${total} chunks`);
        lastReported = completed;
      }
    })
    .build();
  const bytes = statSync(result.outputFile).size;
  const state = result.unchanged
    ? 'unchanged'
    : result.indexed
      ? `${result.chunkCount} chunks x ${result.dimensions} dimensions written`
      : 'below threshold; metadata only';
  console.log(
    `skills index: ${result.skillCount} skills, ${state}, ${bytes} bytes, ${(performance.now() - started).toFixed(1)} ms`,
  );
  console.log(result.outputFile);
}

export async function runBuildIndexMain(
  isMain = import.meta.main,
  args = process.argv.slice(2),
): Promise<void> {
  if (!isMain) return;
  await buildScaleSkillsIndex({ ifPresent: args.includes('--if-present') });
}

await runBuildIndexMain();
