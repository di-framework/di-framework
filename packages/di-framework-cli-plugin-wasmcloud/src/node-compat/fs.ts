import { nodeCompatSeed } from './seed-virtual.js';

type ErrnoException = Error & {
  code: string;
  errno: number;
  syscall: string;
  path: string;
};

function errno(code: string, syscall: string, path: string, errnoValue: number): ErrnoException {
  const error = new Error(
    `${code}: no such file or directory, ${syscall} '${path}'`,
  ) as ErrnoException;
  error.code = code;
  error.errno = errnoValue;
  error.syscall = syscall;
  error.path = path;
  return error;
}

export function normalizeFsPath(path: string, cwd = nodeCompatSeed.cwd): string {
  const base = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
  const parts: string[] = [];
  for (const part of base.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function encodingName(encoding: unknown): string | undefined {
  if (typeof encoding === 'string') return encoding;
  if (encoding !== null && typeof encoding === 'object' && 'encoding' in encoding) {
    const value = (encoding as { encoding?: unknown }).encoding;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function asText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

export function readFileSync(
  path: string,
  encoding?: string | { encoding?: string | null },
): string | Uint8Array {
  const normalized = normalizeFsPath(String(path));
  const content = nodeCompatSeed.files[normalized];
  if (content === undefined) {
    throw errno('ENOENT', 'open', normalized, -2);
  }
  if (encodingName(encoding) !== undefined) return content;
  const bytes = new TextEncoder().encode(content);
  return typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes);
}

export function writeFileSync(
  path: string,
  data: string | Uint8Array,
  _encoding?: string | { encoding?: string | null },
): void {
  nodeCompatSeed.files[normalizeFsPath(String(path))] = asText(data);
}

function directoryKey(path: string): string {
  const normalized = normalizeFsPath(path).replace(/\/$/, '');
  return normalized === '' ? '/' : `${normalized}/`;
}

export function existsSync(path: string): boolean {
  const normalized = normalizeFsPath(String(path));
  return normalized in nodeCompatSeed.files || directoryKey(normalized) in nodeCompatSeed.files;
}

export function mkdirSync(
  path: string,
  options?: { recursive?: boolean } | number,
): string | undefined {
  const normalized = normalizeFsPath(String(path)).replace(/\/$/, '') || '/';
  const recursive = typeof options === 'object' && options?.recursive === true;
  if (normalized in nodeCompatSeed.files || directoryKey(normalized) in nodeCompatSeed.files) {
    if (recursive) return undefined;
    const error = errno('EEXIST', 'mkdir', normalized, -17);
    error.message = `EEXIST: file already exists, mkdir '${normalized}'`;
    throw error;
  }
  nodeCompatSeed.files[directoryKey(normalized)] = '';
  return recursive ? normalized : undefined;
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export default {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
};
