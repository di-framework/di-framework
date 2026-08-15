import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORPUS_REPOSITORY, checkoutDirectory, defaultSkillsDirectory } from './corpus.ts';

async function run(command: readonly string[]): Promise<void> {
  const process = Bun.spawn([...command], { stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

export async function fetchCorpus(): Promise<void> {
  if (existsSync(checkoutDirectory)) {
    await run(['git', '-C', checkoutDirectory, 'pull', '--ff-only']);
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
  await run(['git', '-C', checkoutDirectory, 'sparse-checkout', 'set', 'skills']);
  await run(['git', '-C', checkoutDirectory, 'rev-parse', 'HEAD']);
  console.log(`skills directory: ${defaultSkillsDirectory}`);
}

if (import.meta.main) await fetchCorpus();
