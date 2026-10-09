import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { $ } from 'bun';

const SPECIFIER = 'shared/compare';

/** Compile the internal compare helper so package builds can typecheck against it. */
export async function ensureSharedCompare(workspaceRoot: string): Promise<void> {
  const dir = join(workspaceRoot, 'packages/shared');
  if (!existsSync(join(dir, 'tsconfig.build.json'))) return;
  await $`rm -rf ${join(dir, 'dist')}`.quiet();
  await $`cd ${dir} && bun x tsc -p tsconfig.build.json --incremental false`.quiet();
}

function collectEmitted(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectEmitted(path, files);
      continue;
    }
    if (entry.isFile() && (path.endsWith('.js') || path.endsWith('.d.ts'))) files.push(path);
  }
}

function importsSharedCompare(source: string): boolean {
  return source.includes(`'${SPECIFIER}'`) || source.includes(`"${SPECIFIER}"`);
}

/**
 * Copy the built compare helper into a package dist and rewrite imports to it.
 * `shared` is an unpublished workspace package, so published output cannot import it.
 */
export function vendorSharedCompare(distDir: string, sharedDistDir: string): void {
  if (!existsSync(distDir)) return;
  const files: string[] = [];
  collectEmitted(distDir, files);
  const hits: Array<{ file: string; source: string }> = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (importsSharedCompare(source)) hits.push({ file, source });
  }
  if (hits.length === 0) return;

  const js = join(sharedDistDir, 'compare.js');
  const dts = join(sharedDistDir, 'compare.d.ts');
  if (!existsSync(js) || !existsSync(dts)) {
    throw new Error(`Missing built shared compare at ${sharedDistDir}`);
  }

  const destDir = join(distDir, 'shared');
  mkdirSync(destDir, { recursive: true });
  const destJs = join(destDir, 'compare.js');
  copyFileSync(js, destJs);
  copyFileSync(dts, join(destDir, 'compare.d.ts'));

  for (const { file, source } of hits) {
    let spec = relative(dirname(file), destJs).split(sep).join('/');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const next = source
      .replaceAll(`'${SPECIFIER}'`, `'${spec}'`)
      .replaceAll(`"${SPECIFIER}"`, `"${spec}"`);
    if (next !== source) writeFileSync(file, next);
  }
}
