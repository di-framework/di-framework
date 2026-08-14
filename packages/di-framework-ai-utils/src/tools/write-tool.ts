import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { functionToolCallback, type ToolCallback } from '@di-framework/ai';
import {
  type AllowedDirectories,
  resolveAllowedDirectories,
} from '../sandbox/allowed-directories.ts';
import { assertPathAllowed } from '../sandbox/paths.ts';

export interface WriteToolOptions {
  readonly allowedDirectories: AllowedDirectories;
}

export interface WriteInput {
  readonly filePath?: string;
  readonly content?: string;
}

export function writeTool(options: WriteToolOptions): ToolCallback {
  return functionToolCallback<WriteInput, string>({
    name: 'Write',
    description: `Writes a file in the allowed directories (creates or overwrites).

Usage:
- Prefer Edit for existing files
- Read a file before overwriting it
- Parent directories are created automatically
- filePath should be absolute when possible`,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'The path to write (absolute preferred)',
        },
        content: {
          type: 'string',
          description: 'File contents. Defaults to empty.',
        },
      },
      required: ['filePath'],
    },
    call: (input) => {
      const filePath = input?.filePath?.trim() ?? '';
      const access = assertPathAllowed(
        filePath,
        resolveAllowedDirectories(options.allowedDirectories),
      );
      if (!access.ok) return access.error;

      if (existsSync(access.path) && statSync(access.path).isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}`;
      }

      const existed = existsSync(access.path);
      try {
        mkdirSync(dirname(access.path), { recursive: true });
        const content = input?.content ?? '';
        writeFileSync(access.path, content, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        const verb = existed ? 'overwrote' : 'created';
        return `Successfully ${verb} file: ${access.path} (${bytes} bytes)`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error writing file: ${message}`;
      }
    },
  });
}
