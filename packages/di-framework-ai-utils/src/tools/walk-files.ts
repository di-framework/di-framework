import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage']);

export function walkFiles(
  dir: string,
  depth: number,
  maxDepth: number,
  visit: (file: string) => void,
): void {
  if (depth > maxDepth) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(full, depth + 1, maxDepth, visit);
      } else if (entry.isFile()) {
        visit(full);
      }
    }
  } catch {
    // Unreadable directories are skipped.
  }
}
