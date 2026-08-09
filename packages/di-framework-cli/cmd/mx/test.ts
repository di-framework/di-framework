import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
// @ts-expect-error — static import embeds the file at compile time
import E2E_SCRIPT from '../../scripts/e2e-test.sh' with { type: 'text' };

export async function test(script: string = E2E_SCRIPT) {
  const dir = mkdtempSync(join(tmpdir(), 'di-e2e-'));
  const tmp = join(dir, 'test.sh');
  writeFileSync(tmp, script, { mode: 0o755 });
  try {
    await $`bash ${tmp}`.env(process.env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handleTestFailure(err: unknown): never {
  console.error('Tests failed:', err);
  process.exit(1);
}

/** CLI main gate — `isMain` is injectable so tests can cover the entry path. */
export function runTestMain(
  isMain = import.meta.main,
  start: () => Promise<void> = () => test().catch(handleTestFailure),
): void {
  if (isMain) {
    void start();
  }
}

runTestMain();
