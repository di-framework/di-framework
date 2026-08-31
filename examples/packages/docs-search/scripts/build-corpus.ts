/**
 * Build data/corpus.json from Writerside markdown topics.
 * Run from package root: `bun run corpus`
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const topicsDir = join(ROOT, 'docs/Writerside/topics');
const outFile = process.env.CORPUS_OUT ?? join(import.meta.dir, '../data/corpus.json');
const docsBase = process.env.DOCS_BASE_URL ?? 'https://docs.di-framework.dev';
const versionRaw = process.env.DOCS_VERSION ?? 'latest';
const version =
  versionRaw === 'latest' || versionRaw === 'current'
    ? 'latest'
    : versionRaw.startsWith('v')
      ? versionRaw
      : `v${versionRaw}`;

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
  const objectID = version === 'latest' ? `docs_${id}` : `docs_${id}__${version}`;
  const prefix = version === 'latest' ? '' : `/${version}`;
  return {
    objectID,
    url: `${docsBase.replace(/\/$/, '')}${prefix}/${id}.html`,
    pageTitle: title,
    mainTitle: title,
    breadcrumbs: `Docs|${title}`,
    content,
    product: 'd',
    version,
  };
});

writeFileSync(
  outFile,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2)}\n`,
);
console.log(`Wrote ${docs.length} topics → ${outFile}`);
