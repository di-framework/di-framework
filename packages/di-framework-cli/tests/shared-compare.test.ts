import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vendorSharedCompare } from '../scripts/shared-compare';

test('vendors shared/compare into package dist and leaves other imports alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-compare-'));
  try {
    const sharedDist = join(root, 'shared-dist');
    mkdirSync(sharedDist, { recursive: true });
    writeFileSync(join(sharedDist, 'compare.js'), 'export const compareCodeUnits = () => 0;\n');
    writeFileSync(
      join(sharedDist, 'compare.d.ts'),
      'export declare const compareCodeUnits: (left: string, right: string) => number;\n',
    );

    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'blob'), { recursive: true });
    writeFileSync(
      join(dist, 'blob', 'adapter.js'),
      "import { compareCodeUnits } from 'shared/compare';\nexport const sort = compareCodeUnits;\n",
    );
    writeFileSync(join(dist, 'index.js'), "export { ok } from './blob/adapter.js';\n");
    writeFileSync(join(dist, 'order.d.ts'), 'export { compareCodeUnits } from "shared/compare";\n');

    vendorSharedCompare(dist, sharedDist);
    vendorSharedCompare(dist, sharedDist);

    expect(readFileSync(join(dist, 'blob', 'adapter.js'), 'utf8')).toContain(
      "from '../shared/compare.js'",
    );
    expect(readFileSync(join(dist, 'order.d.ts'), 'utf8')).toContain('from "./shared/compare.js"');
    expect(readFileSync(join(dist, 'index.js'), 'utf8')).toContain("from './blob/adapter.js'");
    expect(readFileSync(join(dist, 'shared', 'compare.js'), 'utf8')).toContain('compareCodeUnits');
    expect(readFileSync(join(dist, 'shared', 'compare.d.ts'), 'utf8')).toContain(
      'compareCodeUnits',
    );

    const absent = join(root, 'empty-dist');
    mkdirSync(absent, { recursive: true });
    writeFileSync(join(absent, 'index.js'), 'export const ok = 1;\n');
    vendorSharedCompare(absent, join(root, 'missing-shared'));
    expect(readFileSync(join(absent, 'index.js'), 'utf8')).toBe('export const ok = 1;\n');
    vendorSharedCompare(join(root, 'missing-dist'), sharedDist);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vendorSharedCompare fails when emitted files still import a missing build', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-compare-missing-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), "import { compareCodeUnits } from 'shared/compare';\n");
    expect(() => vendorSharedCompare(dist, join(root, 'missing'))).toThrow(
      'Missing built shared compare',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
