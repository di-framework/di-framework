/**
 * Build data/corpus.json from Writerside markdown topics.
 * Run from package root: `bun run corpus`
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const topicsDir = join(ROOT, 'docs/Writerside/topics');
const outFile = join(import.meta.dir, '../data/corpus.json');
const docsBase = process.env.DOCS_BASE_URL ?? 'https://docs.di-framework.dev';

const files = readdirSync(topicsDir).filter((f) => f.endsWith('.md') && f !== 'starter-topic.md');

const docs = files.map((f) => {
  const raw = readFileSync(join(topicsDir, f), 'utf8');
  const lines = raw.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, '').trim() : basename(f, '.md');
  const content = raw
    .replace(/^#\s+.*$/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
  const id = basename(f, '.md');
  return {
    objectID: `docs_${id}`,
    url: `${docsBase}/${id}.html`,
    pageTitle: title,
    mainTitle: title,
    breadcrumbs: `Docs|${title}`,
    content,
    product: 'd',
    version: 'latest',
  };
});

writeFileSync(
  outFile,
  JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2) + '\n',
);
console.log(`Wrote ${docs.length} topics → ${outFile}`);
