import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORPUS_REPOSITORY, checkoutDirectory, defaultSkillsDirectory } from './corpus.ts';

export const AWESOME_COPILOT_REVISION = 'a80885b76044550770f60f360f8a0e5ae3524a31';

async function run(command: readonly string[]): Promise<void> {
  const process = Bun.spawn([...command], { stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

export async function fetchCorpus(): Promise<void> {
  if (existsSync(checkoutDirectory)) {
    await run([
      'git',
      '-C',
      checkoutDirectory,
      'fetch',
      '--depth',
      '1',
      'origin',
      AWESOME_COPILOT_REVISION,
    ]);
  } else {
    mkdirSync(dirname(checkoutDirectory), { recursive: true });
    await run([
      'gh',
      'repo',
      'clone',
      CORPUS_REPOSITORY,
      checkoutDirectory,
      '--',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
    ]);
  }
  await run(['git', '-C', checkoutDirectory, 'checkout', '--detach', AWESOME_COPILOT_REVISION]);
  await run(['git', '-C', checkoutDirectory, 'sparse-checkout', 'set', 'skills']);
  const revision = Bun.spawnSync(['git', '-C', checkoutDirectory, 'rev-parse', 'HEAD']);
  const actual = revision.stdout.toString().trim();
  if (revision.exitCode !== 0 || actual !== AWESOME_COPILOT_REVISION) {
    throw new Error(
      `Expected awesome-copilot ${AWESOME_COPILOT_REVISION}; found ${actual || 'unknown'}`,
    );
  }
  console.log(actual);
  console.log(`skills directory: ${defaultSkillsDirectory}`);
}

if (import.meta.main) await fetchCorpus();
