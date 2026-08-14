import { existsSync, readFileSync, statSync } from 'node:fs';
import { functionToolCallback, type ToolCallback } from '@di-framework/ai';
import { assertPathAllowed } from '../sandbox/paths.ts';

export const DEFAULT_READ_LIMIT = 2000;
export const DEFAULT_MAX_LINE_CHARS = 2000;

export interface ReadToolOptions {
  readonly allowedDirectories: readonly string[];
  readonly maxLineChars?: number;
}

export interface ReadInput {
  readonly filePath?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export function readTool(options: ReadToolOptions): ToolCallback {
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  return functionToolCallback<ReadInput, string>({
    name: 'Read',
    description: `Reads a file from the local filesystem. Use this to load skill references and other files inside the allowed directories.

Usage:
- filePath should be absolute when possible
- By default reads up to ${DEFAULT_READ_LIMIT} lines from the start
- Optional offset (1-indexed) and limit paginate large files
- Lines longer than ${maxLineChars} characters are truncated
- Results use cat -n format (line numbers starting at 1)
- This tool reads files, not directories`,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'The path to the file to read (absolute preferred)',
        },
        offset: {
          type: 'integer',
          description: '1-indexed line number to start from',
        },
        limit: {
          type: 'integer',
          description: `Number of lines to read (default ${DEFAULT_READ_LIMIT})`,
        },
      },
      required: ['filePath'],
    },
    call: (input) => {
      const filePath = input?.filePath?.trim() ?? '';
      const access = assertPathAllowed(filePath, options.allowedDirectories);
      if (!access.ok) return access.error;

      if (!existsSync(access.path)) {
        return `Error: File does not exist: ${filePath}`;
      }
      if (statSync(access.path).isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}`;
      }

      const startLine = Math.max(1, input?.offset ?? 1);
      const maxLines = Math.max(1, input?.limit ?? DEFAULT_READ_LIMIT);

      let content: string;
      try {
        content = readFileSync(access.path, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error reading file: ${message}`;
      }

      const allLines = content.split(/\r?\n/);
      // Drop a trailing empty line produced by a final newline.
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }

      if (allLines.length === 0) {
        return `File is empty: ${filePath}`;
      }
      if (startLine > allLines.length) {
        return `No lines to read. File has ${allLines.length} lines, but offset was ${startLine}`;
      }

      const slice = allLines.slice(startLine - 1, startLine - 1 + maxLines);
      const endLine = startLine + slice.length - 1;
      const numbered = slice.map((line, index) => {
        const text =
          line.length > maxLineChars ? `${line.slice(0, maxLineChars)}... (line truncated)` : line;
        const n = startLine + index;
        return `${String(n).padStart(6, ' ')}\t${text}`;
      });

      return `File: ${access.path}\nShowing lines ${startLine}-${endLine} of ${allLines.length}\n\n${numbered.join('\n')}\n`;
    },
  });
}
