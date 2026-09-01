import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { CliIo, CommandResult } from '../../command';
import { CommandFailure } from '../../command';
// @ts-expect-error — static import embeds the file at compile time
import E2E_SCRIPT from '../../scripts/e2e-test.sh' with { type: 'text' };

export async function test(script: string = E2E_SCRIPT): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'di-e2e-'));
  const tmp = join(dir, 'test.sh');
  writeFileSync(tmp, script, { mode: 0o755 });
  try {
    await $`bash ${tmp}`.env(process.env).quiet();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runMxTest(
  args: readonly string[],
  _io: CliIo,
  script: string = E2E_SCRIPT,
): Promise<CommandResult> {
  if (args.length > 0) {
    throw new CommandFailure('INVALID_USAGE', `mx test does not accept arguments: ${args[0]}`, 2, {
      argument: args[0],
    });
  }
  await test(script);
  return { data: { passed: true, suite: 'e2e' }, text: 'E2E tests passed.' };
}

/** Standalone boundary; reports failures without terminating an embedding process. */
export async function runTestMain(
  isMain = import.meta.main,
  start: (args: readonly string[], io: CliIo) => Promise<CommandResult> = runMxTest,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  if (!isMain) return;
  try {
    await start(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
  } catch (error) {
    process.stderr.write(
      `Tests failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    setExitCode(error instanceof CommandFailure ? error.exitCode : 1);
  }
}

void runTestMain();
