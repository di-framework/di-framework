import { $ } from 'bun';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error — static import embeds the file at compile time
import E2E_SCRIPT from '../scripts/e2e-test.sh' with { type: 'text' };

export async function test() {
  const tmp = join(tmpdir(), `di-framework-e2e-${process.pid}.sh`);
  writeFileSync(tmp, E2E_SCRIPT, { mode: 0o755 });
  try {
    await $`bash ${tmp}`.env(process.env);
  } finally {
    unlinkSync(tmp);
  }
}

if (import.meta.main) {
  test().catch((err) => {
    console.error('Tests failed:', err);
    process.exit(1);
  });
}
