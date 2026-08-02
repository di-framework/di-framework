import { $ } from 'bun';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error — static import embeds the file at compile time
import E2E_SCRIPT from '../scripts/e2e-test.sh' with { type: 'text' };

export async function test(script: string = E2E_SCRIPT) {
  const tmp = join(tmpdir(), `di-framework-e2e-${process.pid}.sh`);
  writeFileSync(tmp, script, { mode: 0o755 });
  try {
    await $`bash ${tmp}`.env(process.env);
  } finally {
    unlinkSync(tmp);
  }
}

/** Shared entrypoint error handler (kept separate so tests can cover it). */
export function handleTestFailure(err: unknown): never {
  console.error('Tests failed:', err);
  process.exit(1);
}

if (import.meta.main) {
  test().catch(handleTestFailure);
}
