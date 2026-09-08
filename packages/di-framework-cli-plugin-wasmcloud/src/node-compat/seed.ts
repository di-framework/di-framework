import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.di-framework', 'coverage']);
const SEED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.env']);

export const MAX_SEEDED_FILE_BYTES = 256 * 1024;
export const MAX_SEEDED_TOTAL_BYTES = 1024 * 1024;

export const NODE_COMPAT_SEED_ID = 'virtual:di-framework-node-fs-seed';

export type NodeCompatSeed = {
  files: Record<string, string>;
  environ: Record<string, string>;
  cwd: string;
};

export const EMPTY_NODE_COMPAT_SEED: NodeCompatSeed = {
  files: {},
  environ: {},
  cwd: '/',
};

export function toPosixGuestPath(relativePath: string): string {
  return `/${relativePath.split(sep).join('/')}`;
}

export function compactEnviron(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (env === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isSeededName(name: string): boolean {
  return name === '.env' || SEED_EXTENSIONS.has(extname(name));
}

export function collectProjectFiles(projectRoot: string | undefined): Record<string, string> {
  if (projectRoot === undefined || !existsSync(projectRoot)) return {};
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (directory: string) => {
    if (total >= MAX_SEEDED_TOTAL_BYTES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= MAX_SEEDED_TOTAL_BYTES) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isSeededName(entry.name)) continue;
      try {
        const size = statSync(absolute).size;
        if (size > MAX_SEEDED_FILE_BYTES || total + size > MAX_SEEDED_TOTAL_BYTES) continue;
        files[toPosixGuestPath(relative(projectRoot, absolute))] = readFileSync(absolute, 'utf8');
        total += size;
      } catch {}
    }
  };
  walk(projectRoot);
  return files;
}

export function createNodeCompatSeed(options: {
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  projectRoot?: string;
}): NodeCompatSeed {
  return {
    files: options.files ?? collectProjectFiles(options.projectRoot),
    environ: compactEnviron(options.env),
    cwd: options.cwd ?? '/',
  };
}

export function renderNodeCompatSeedModule(seed: NodeCompatSeed): string {
  return `export const nodeCompatSeed = ${JSON.stringify({
    files: seed.files,
    environ: seed.environ,
    cwd: seed.cwd,
  })};\n`;
}

export function isNodeCompatSeedSource(source: string): boolean {
  return source.includes('seed-virtual') || source === NODE_COMPAT_SEED_ID;
}
