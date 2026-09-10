import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixEsmImports } from '../scripts/fix-esm-imports';

test('emitted imports resolve in Node while source files and external imports stay intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'esm-imports-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'value.js'), 'export const value = 42;');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested/index.js'), "export { value } from '../value';");
    const source = "export { value } from './value';";
    writeFileSync(join(root, 'source.ts'), source);
    writeFileSync(join(root, 'index.d.ts'), "export { value } from './nested';");
    writeFileSync(
      join(root, 'index.js'),
      `
import { value } from './value';
export { value } from './nested';
import { strictEqual } from 'node:assert';
strictEqual(value, (await import('./nested')).value);
strictEqual((await import('./value.js')).value, 42);
`,
    );
    fixEsmImports(root);
    const first = readFileSync(join(root, 'index.js'), 'utf8');
    fixEsmImports(root);
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toBe(first);
    expect(readFileSync(join(root, 'source.ts'), 'utf8')).toBe(source);
    expect(readFileSync(join(root, 'index.d.ts'), 'utf8')).toContain('./nested/index.js');
    const result = Bun.spawn(['node', join(root, 'index.js')], { stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(result.stderr).text();
    expect(await result.exited, stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
