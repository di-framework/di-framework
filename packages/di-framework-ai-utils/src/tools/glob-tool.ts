import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { functionToolCallback, type ToolCallback } from '@di-framework/ai';
import { assertPathAllowed, uniqueResolvedRoots } from '../sandbox/paths.ts';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage']);
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_DEPTH = 20;

export interface GlobToolOptions {
  readonly allowedDirectories: readonly string[];
  readonly workingDirectory?: string;
  readonly maxResults?: number;
  readonly maxDepth?: number;
}

export interface GlobInput {
  readonly pattern?: string;
  readonly path?: string;
}

export function globTool(options: GlobToolOptions): ToolCallback {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const roots = uniqueResolvedRoots(options.allowedDirectories);
  const defaultRoot = options.workingDirectory
    ? uniqueResolvedRoots([options.workingDirectory])[0]
    : roots[0];

  return functionToolCallback<GlobInput, string>({
    name: 'Glob',
    description: `Fast file pattern matching under the allowed skill/workspace directories.
Supports globs like "**/*.md" or "scripts/*". Returns matching paths sorted by name.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g. "**/*.md")',
        },
        path: {
          type: 'string',
          description: 'Directory to search. Defaults to the workspace root.',
        },
      },
      required: ['pattern'],
    },
    call: (input) => {
      const pattern = input?.pattern?.trim() ?? '';
      if (!pattern) return 'Error: The glob pattern must not be empty';

      const searchRoot = input?.path?.trim() || defaultRoot;
      if (!searchRoot) return 'Error: No search directory configured';

      const access = assertPathAllowed(searchRoot, roots);
      if (!access.ok) return access.error;

      try {
        if (!statSync(access.path).isDirectory()) {
          return `Error: Path is not a directory: ${searchRoot}`;
        }
      } catch {
        return `Error: Directory does not exist: ${searchRoot}`;
      }

      const matcher = compileGlob(pattern);
      const matches: string[] = [];
      walk(access.path, 0, maxDepth, (file) => {
        const rel = relative(access.path, file).split('\\').join('/');
        if (matcher(rel) || matcher(file.split('\\').join('/'))) {
          matches.push(file);
        }
      });
      matches.sort((a, b) => a.localeCompare(b));
      const clipped = matches.slice(0, maxResults);
      if (clipped.length === 0) {
        return `No files matched "${pattern}" under ${access.path}`;
      }
      const suffix =
        matches.length > clipped.length ? `\n… ${matches.length - clipped.length} more` : '';
      return clipped.join('\n') + suffix;
    },
  });
}

function walk(dir: string, depth: number, maxDepth: number, visit: (file: string) => void): void {
  if (depth > maxDepth) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1, maxDepth, visit);
      } else if (entry.isFile()) {
        visit(full);
      }
    }
  } catch {
    // Unreadable directories are skipped.
  }
}

function compileGlob(pattern: string): (value: string) => boolean {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized.charAt(i);
    if (char === '*' && normalized[i + 1] === '*') {
      const after = normalized[i + 2];
      if (after === '/') {
        regex += '(?:.*/)?';
        i += 2;
      } else {
        regex += '.*';
        i += 1;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if ('\\.[]{}()+-^$|'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += '$';
  const re = new RegExp(regex);
  return (value) => re.test(value.replace(/\\/g, '/'));
}
