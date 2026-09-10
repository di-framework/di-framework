/**
 * Backend registry used to turn a file path (or `:memory:`) into a
 * `SqlDatabase`. Native backends register from `./native.js`, which the
 * portable (wasmcloud) entry never imports, so Wasm bundles stay free of
 * `bun:sqlite` / `node:sqlite` references.
 */
import type { SqlDatabase } from './sql-database.js';

export type SqliteBackend = 'bun' | 'node' | 'wasm';

export type SqliteOpener = (path: string) => Promise<SqlDatabase>;

/** Environment variable that forces a backend (`bun`, `node`, or `wasm`). */
export const SQLITE_BACKEND_ENV = 'DI_SQLITE_BACKEND';

const openers = new Map<SqliteBackend, SqliteOpener>();

export function registerSqliteOpener(backend: SqliteBackend, opener: SqliteOpener): void {
  openers.set(backend, opener);
}

export function getSqliteOpener(backend: SqliteBackend): SqliteOpener | undefined {
  return openers.get(backend);
}

export function registeredSqliteBackends(): SqliteBackend[] {
  return Array.from(openers.keys());
}

function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    return env?.[name];
  } catch {
    return undefined;
  }
}

/** Backend explicitly requested through `DI_SQLITE_BACKEND`, if any. */
export function requestedSqliteBackend(): SqliteBackend | undefined {
  const value = readEnv(SQLITE_BACKEND_ENV)?.trim().toLowerCase();
  if (value === 'bun' || value === 'node' || value === 'wasm') return value;
  return undefined;
}

export function isWasmSqliteBackendRequested(): boolean {
  return requestedSqliteBackend() === 'wasm';
}

/**
 * Picks the backend for a path: the environment override, then Bun when its
 * global is present, then Node when a native opener is registered, else Wasm.
 */
export function detectSqliteBackend(options?: {
  bunGlobal?: unknown;
  hasOpener?: (backend: SqliteBackend) => boolean;
}): SqliteBackend {
  const requested = requestedSqliteBackend();
  if (requested) return requested;
  const bunGlobal = options?.bunGlobal ?? (globalThis as { Bun?: unknown }).Bun;
  const hasOpener = options?.hasOpener ?? ((backend) => openers.has(backend));
  if (typeof bunGlobal !== 'undefined' && hasOpener('bun')) {
    return 'bun';
  }
  if (hasOpener('node')) return 'node';
  return 'wasm';
}

function fallbackOrder(backend: SqliteBackend): SqliteBackend[] {
  switch (backend) {
    case 'bun':
      return ['bun', 'node', 'wasm'];
    case 'node':
      return ['node', 'wasm'];
    default:
      return ['wasm'];
  }
}

/**
 * Opens `path` with the preferred backend, falling back to the next available
 * one when the preferred runtime module cannot be loaded or fails to open.
 */
export async function openSqliteDatabase(
  path: string,
  backend: SqliteBackend = detectSqliteBackend(),
  options?: { getOpener?: (backend: SqliteBackend) => SqliteOpener | undefined },
): Promise<SqlDatabase> {
  let lastError: unknown;
  let attempted = 0;
  const getOpener = options?.getOpener ?? ((candidate) => openers.get(candidate));
  for (const candidate of fallbackOrder(backend)) {
    const opener = getOpener(candidate);
    if (!opener) continue;
    attempted++;
    try {
      return await opener(path);
    } catch (error) {
      lastError = error;
    }
  }
  if (attempted === 0) {
    throw new Error(
      `No SQLite backend is registered for '${backend}'. Import '@di-framework/repo' (package entry) to register bun:sqlite/node:sqlite, or '@di-framework/repo/portable' for the Wasm backend.`,
    );
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(`Unsupported database connection string or runtime: ${path}${detail}`, {
    cause: lastError,
  });
}
