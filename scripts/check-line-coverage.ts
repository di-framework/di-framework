#!/usr/bin/env bun
/**
 * Fail CI when any non-test source file in the LCOV report is below 100% lines.
 * Complements Bun's coverageThreshold (which applies to the aggregate report).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lcovPath = resolve(process.cwd(), 'coverage/lcov.info');
if (!existsSync(lcovPath)) {
  console.error(`Missing ${lcovPath}. Run: bun test --coverage --coverage-reporter=lcov`);
  process.exit(1);
}

const isSource = (sf: string) => {
  if (!sf.includes('packages/') && !sf.includes('examples/')) return false;
  if (sf.includes('/tests/') || sf.includes('\\tests\\')) return false;
  if (sf.includes('/dist/') || sf.includes('\\dist\\')) return false;
  if (sf.endsWith('.test.ts') || sf.endsWith('.test.js')) return false;
  if (sf.includes('preload-wasm-mock')) return false;
  if (sf.includes('/scripts/')) return false;
  return sf.endsWith('.ts') || sf.endsWith('.js') || sf.endsWith('.tsx');
};

const misses: Array<{ file: string; uncovered: number[] }> = [];
for (const record of readFileSync(lcovPath, 'utf8').split('end_of_record')) {
  const sfLine = record.split('\n').find((l) => l.startsWith('SF:'));
  if (!sfLine) continue;
  const file = sfLine.slice(3);
  if (!isSource(file)) continue;
  const uncovered: number[] = [];
  for (const line of record.split('\n')) {
    if (!line.startsWith('DA:')) continue;
    const [lineno, hits] = line.slice(3).split(',');
    if (Number(hits) === 0) uncovered.push(Number(lineno));
  }
  if (uncovered.length) misses.push({ file, uncovered });
}

if (misses.length === 0) {
  console.log('Line coverage check passed (100% on reported source files).');
  process.exit(0);
}

console.error(`Line coverage check failed (${misses.length} file(s) below 100%):\n`);
for (const { file, uncovered } of misses) {
  const sample = uncovered.slice(0, 12).join(',');
  const more = uncovered.length > 12 ? `…(+${uncovered.length - 12})` : '';
  console.error(`  ${file}: ${uncovered.length} uncovered line(s) [${sample}${more}]`);
}
process.exit(1);
