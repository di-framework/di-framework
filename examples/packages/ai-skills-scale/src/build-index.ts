import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  type BuildSkillsIndexResult,
  DEFAULT_SKILLS_INDEX_THRESHOLD,
  DEFAULT_SKILLS_RETRIEVAL_LIMIT,
  SkillsIndex,
} from '@di-framework/ai-utils';
import { defaultIndexFile, defaultSkillsDirectory, loadSkillCorpus } from './corpus.ts';
import {
  type IndexBuildMeasurements,
  indexMeasurementsFile,
  preserveIndexBuildMeasurements,
} from './index-measurements.ts';

export { defaultIndexFile } from './corpus.ts';
export {
  type IndexBuildMeasurements,
  indexMeasurementsFile,
  preserveIndexBuildMeasurements,
} from './index-measurements.ts';

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
  let peakMemoryBytes = process.memoryUsage.rss();
  const memorySampler = setInterval(() => {
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage.rss());
  }, 25);
  memorySampler.unref();
  let lastReported = 0;
  let result: BuildSkillsIndexResult;
  try {
    result = await SkillsIndex.builder()
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
  } finally {
    clearInterval(memorySampler);
  }
  const bytes = statSync(result.outputFile).size;
  const elapsedMilliseconds = performance.now() - started;
  const currentMeasurements: IndexBuildMeasurements = {
    schemaVersion: 1,
    indexingMilliseconds: elapsedMilliseconds,
    artifactBytes: bytes,
    peakMemoryBytes: Math.max(peakMemoryBytes, process.memoryUsage.rss()),
  };
  const measurementsPath = indexMeasurementsFile(result.outputFile);
  const measurements = preserveIndexBuildMeasurements(
    currentMeasurements,
    result.unchanged ? readIndexBuildMeasurements(measurementsPath) : undefined,
    result.unchanged === true,
  );
  writeFileSync(measurementsPath, `${JSON.stringify(measurements, null, 2)}\n`);
  const state = result.unchanged
    ? 'unchanged'
    : result.indexed
      ? `${result.chunkCount} chunks x ${result.dimensions} dimensions written`
      : 'below threshold; metadata only';
  console.log(
    `skills index: ${result.skillCount} skills, ${state}, ${bytes} bytes, ${elapsedMilliseconds.toFixed(1)} ms`,
  );
  console.log(result.outputFile);
}

function readIndexBuildMeasurements(file: string): IndexBuildMeasurements | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<IndexBuildMeasurements>;
    if (
      value.schemaVersion === 1 &&
      typeof value.indexingMilliseconds === 'number' &&
      typeof value.artifactBytes === 'number' &&
      typeof value.peakMemoryBytes === 'number'
    ) {
      return value as IndexBuildMeasurements;
    }
  } catch {
    // A missing or malformed measurement receipt is replaced by the current measurement.
  }
  return undefined;
}

export async function runBuildIndexMain(
  isMain = import.meta.main,
  args = process.argv.slice(2),
): Promise<void> {
  if (!isMain) return;
  await buildScaleSkillsIndex(parseBuildIndexOptions(args));
}

export function parseBuildIndexOptions(args: readonly string[]): {
  skillsDirectory?: string;
  outputFile?: string;
  ifPresent?: boolean;
} {
  const options: { skillsDirectory?: string; outputFile?: string; ifPresent?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === '--if-present') options.ifPresent = true;
    else if (flag === '--skills-dir') options.skillsDirectory = value();
    else if (flag === '--output') options.outputFile = value();
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

await runBuildIndexMain();
