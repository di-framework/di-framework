import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { functionToolCallback, type ToolCallback } from '@di-framework/ai';
import {
  type AllowedDirectories,
  resolveAllowedDirectories,
} from '../sandbox/allowed-directories.ts';
import { assertPathAllowed, uniqueResolvedRoots } from '../sandbox/paths.ts';

export interface ListDirectoryToolOptions {
  readonly allowedDirectories: AllowedDirectories;
  readonly workingDirectory?: string;
}

export interface ListDirectoryInput {
  readonly path?: string;
}

export function listDirectoryTool(options: ListDirectoryToolOptions): ToolCallback {
  const defaultRoot = options.workingDirectory
    ? uniqueResolvedRoots([options.workingDirectory])[0]
    : undefined;

  return functionToolCallback<ListDirectoryInput, string>({
    name: 'ListDirectory',
    description: `List files and directories inside the allowed skill/workspace directories.

Usage:
- path is optional and defaults to the workspace root
- Results are names with a trailing / for directories`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (absolute preferred)',
        },
      },
    },
    call: (input) => {
      const roots = uniqueResolvedRoots(resolveAllowedDirectories(options.allowedDirectories));
      const target = input?.path?.trim() || defaultRoot || roots[0];
      if (!target) return 'Error: No directory configured';
      const access = assertPathAllowed(target, roots);
      if (!access.ok) return access.error;
      try {
        if (!statSync(access.path).isDirectory()) {
          return `Error: Path is not a directory: ${target}`;
        }
      } catch {
        return `Error: Directory does not exist: ${target}`;
      }
      try {
        const names = readdirSync(access.path, { withFileTypes: true })
          .map((entry) => {
            const full = join(access.path, entry.name);
            return entry.isDirectory() ? `${full}/` : full;
          })
          .sort((a, b) => a.localeCompare(b));
        if (names.length === 0) return `Empty directory: ${access.path}`;
        return `${access.path}\n${names.join('\n')}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error listing directory: ${message}`;
      }
    },
  });
}
