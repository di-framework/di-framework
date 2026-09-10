/**
 * `SqlDatabase` adapter for the `di-framework:sqlite/database@0.1.0` WIT
 * import. The host owns SQLite; the guest exchanges `sql-value` variants and
 * keeps one connection per file with serialized transactions, because the
 * WASI filesystem provides no file locking.
 *
 * Component bindings differ in how they surface `result<T, error>`: some
 * return `{ tag: 'ok' | 'err', val }` records, others throw an error object
 * carrying the variant as `payload`. Both shapes are normalized here.
 */
import { registerSqliteOpener } from './open.js';
import {
  createSqlDatabase,
  type SqlDatabase,
  type SqlDriver,
  type SqlRow,
} from './sql-database.js';

export const WASM_SQLITE_MODULE_ID = 'di-framework:sqlite/database@0.1.0';

export type WasmSqliteJournalMode = 'delete' | 'persist' | 'memory';
export type WasmSqliteSyncMode = 'off' | 'normal' | 'full';

/** Pragmas the WIT contract requires for durable single-writer WASI storage. */
export const WASM_SQLITE_DEFAULT_JOURNAL_MODE: WasmSqliteJournalMode = 'delete';
export const WASM_SQLITE_DEFAULT_SYNC_MODE: WasmSqliteSyncMode = 'full';

export type WasmSqlValue =
  | { tag: 'null'; val?: undefined }
  | { tag: 'integer'; val: bigint | number }
  | { tag: 'real'; val: number }
  | { tag: 'text'; val: string }
  | { tag: 'blob'; val: Uint8Array | ArrayLike<number> };

export type WasmSqlRow = Array<[string, WasmSqlValue]>;

export type WasmResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

/** Either a bare value (bindings that throw on `err`) or a result record. */
export type WasmMaybeResult<T> = T | WasmResult<T> | Promise<T | WasmResult<T>>;

/** Guest-side view of the `connection` resource. */
export interface WasmSqliteConnection {
  run(sql: string, params: WasmSqlValue[]): WasmMaybeResult<bigint | number>;
  query(sql: string, params: WasmSqlValue[]): WasmMaybeResult<WasmSqlRow[]>;
  first(sql: string, params: WasmSqlValue[]): WasmMaybeResult<WasmSqlRow | undefined | null>;
  exec(sql: string): WasmMaybeResult<void>;
  close(): WasmMaybeResult<void>;
}

/** Options record accepted by hosts whose `open` takes `option<open-options>`. */
export interface WasmSqliteOpenOptions {
  /** Create the database file when it does not exist. Default: true. */
  create?: boolean;
  /** Open read-only. Default: false. */
  readOnly?: boolean;
  /** `PRAGMA synchronous`. Default: `full`. */
  synchronous?: WasmSqliteSyncMode;
  /** `PRAGMA journal_mode`. WAL is never offered on WASI. Default: `delete`. */
  journalMode?: WasmSqliteJournalMode;
  /** `PRAGMA busy_timeout` in milliseconds. */
  busyTimeoutMs?: number;
  /** `PRAGMA foreign_keys`. */
  foreignKeys?: boolean;
}

/** Guest-side view of the `database` interface module. */
export interface WasmSqliteModule {
  open(path: string, options?: WasmSqliteOpenOptions): WasmMaybeResult<WasmSqliteConnection>;
}

export interface WasmSqliteErrorRecord {
  code?: number;
  extendedCode?: number;
  message?: string;
}

export interface WasmSqliteErrorPayload {
  tag: string;
  val?: string | WasmSqliteErrorRecord | undefined;
}

export class WasmSqliteError extends Error {
  readonly tag: string;
  readonly detail?: string;
  readonly code?: number;
  readonly extendedCode?: number;

  constructor(payload: WasmSqliteErrorPayload, cause?: unknown) {
    let detail: string | undefined;
    let code: number | undefined;
    let extendedCode: number | undefined;
    if (typeof payload.val === 'string') {
      detail = payload.val;
    } else if (typeof payload.val === 'object' && payload.val !== null) {
      detail = payload.val.message;
      code = payload.val.code;
      extendedCode = payload.val.extendedCode;
    }
    super(detail ? `SQLite ${payload.tag}: ${detail}` : `SQLite ${payload.tag}`, { cause });
    this.name = 'WasmSqliteError';
    this.tag = payload.tag;
    this.detail = detail;
    this.code = code;
    this.extendedCode = extendedCode;
  }
}

function isErrorPayload(value: unknown): value is WasmSqliteErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { tag?: unknown }).tag === 'string' &&
    (value as { tag: string }).tag !== 'ok'
  );
}

/** Normalizes a thrown binding error or an `err` payload into an `Error`. */
export function normalizeWasmSqliteError(error: unknown): Error {
  if (error instanceof WasmSqliteError) return error;
  if (isErrorPayload(error)) return new WasmSqliteError(error);
  if (typeof error === 'object' && error !== null) {
    const payload = (error as { payload?: unknown }).payload;
    if (isErrorPayload(payload)) return new WasmSqliteError(payload, error);
  }
  if (typeof error === 'string') return new WasmSqliteError({ tag: 'other', val: error });
  return error instanceof Error ? error : new Error(String(error));
}

function isResultRecord<T>(value: unknown): value is WasmResult<T> {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as { tag?: unknown }).tag;
  return (tag === 'ok' || tag === 'err') && 'val' in (value as object);
}

/** Unwraps `{ tag: 'ok' | 'err' }` records; passes bare values through. */
export function unwrapWasmResult<T>(value: T | WasmResult<T>): T {
  if (isResultRecord<T>(value)) {
    if (value.tag === 'err') throw normalizeWasmSqliteError(value.val);
    return value.val;
  }
  return value as T;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Converts a bound JavaScript parameter into a `sql-value` variant. */
export function toWasmSqlValue(value: unknown): WasmSqlValue {
  if (value === null || value === undefined) return { tag: 'null' };
  switch (typeof value) {
    case 'bigint':
      // componentize-qjs lowers WIT s64 from JS numbers (f64), not BigInt.
      if (value >= MIN_SAFE && value <= MAX_SAFE) {
        return { tag: 'integer', val: Number(value) };
      }
      throw new TypeError(
        `Cannot bind bigint ${value} as a SQLite parameter; value exceeds Number.MAX_SAFE_INTEGER`,
      );
    case 'number':
      if (Number.isSafeInteger(value)) {
        return { tag: 'integer', val: value };
      }
      return { tag: 'real', val: value };
    case 'boolean':
      return { tag: 'integer', val: value ? 1 : 0 };
    case 'string':
      return { tag: 'text', val: value };
    case 'object':
      if (value instanceof Uint8Array) {
        return { tag: 'blob', val: value };
      }
      if (value instanceof ArrayBuffer) {
        return { tag: 'blob', val: new Uint8Array(value) };
      }
      if (ArrayBuffer.isView(value)) {
        return {
          tag: 'blob',
          val: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        };
      }
      if (value instanceof Date) {
        return { tag: 'text', val: value.toISOString() };
      }
      break;
  }
  const label =
    typeof value === 'object' ? ((value as object).constructor?.name ?? 'object') : typeof value;
  throw new TypeError(
    `Cannot bind ${label} as a SQLite parameter; use null, number, bigint, boolean, string, Date, or Uint8Array`,
  );
}

/** Converts a `sql-value` variant into the JavaScript value native drivers return. */
export function fromWasmSqlValue(value: WasmSqlValue): unknown {
  switch (value.tag) {
    case 'null':
      return null;
    case 'integer': {
      if (typeof value.val === 'number') return value.val;
      return value.val >= MIN_SAFE && value.val <= MAX_SAFE ? Number(value.val) : value.val;
    }
    case 'real':
      return value.val;
    case 'text':
      return value.val;
    case 'blob':
      return value.val instanceof Uint8Array ? value.val : Uint8Array.from(value.val);
    default:
      throw new WasmSqliteError({
        tag: 'value-conversion-failed',
        val: `Unknown sql-value tag ${String((value as { tag?: unknown }).tag)}`,
      });
  }
}

export function toWasmSqlParams(params: readonly unknown[] = []): WasmSqlValue[] {
  return params.map((param) => toWasmSqlValue(param));
}

export function fromWasmSqlRow(row: WasmSqlRow): SqlRow {
  const result: SqlRow = {};
  for (const [column, value] of row) {
    result[column] = fromWasmSqlValue(value);
  }
  return result;
}

async function call<T>(fn: () => WasmMaybeResult<T>): Promise<T> {
  try {
    return unwrapWasmResult(await fn());
  } catch (error) {
    throw normalizeWasmSqliteError(error);
  }
}

/** Wraps an open WIT `connection` resource as a `SqlDatabase`. */
export function createSqlDatabaseFromWasmConnection(connection: WasmSqliteConnection): SqlDatabase {
  const driver: SqlDriver = {
    run: async (sql, params) => {
      const changes = await call(() => connection.run(sql, toWasmSqlParams(params)));
      return { changes: Number(changes ?? 0) };
    },
    query: async (sql, params) => {
      const rows = await call(() => connection.query(sql, toWasmSqlParams(params)));
      return rows.map((row) => fromWasmSqlRow(row));
    },
    first: async (sql, params) => {
      const row = await call(() => connection.first(sql, toWasmSqlParams(params)));
      return row ? fromWasmSqlRow(row) : null;
    },
    exec: async (sql) => {
      await call(() => connection.exec(sql));
    },
    close: async () => {
      await call(() => connection.close());
    },
  };
  return createSqlDatabase(driver);
}

export interface WasmSqliteDatabaseOptions extends WasmSqliteOpenOptions {
  /** Pre-loaded module; skips the dynamic import of the WIT interface. */
  module?: WasmSqliteModule;
  /** Custom loader for the WIT interface module (primarily for tests). */
  loadModule?: () => Promise<WasmSqliteModule>;
  /**
   * Re-apply the journal/synchronous pragmas through `exec` after opening so
   * the contract holds even when the host ignores `open-options`.
   * Defaults to true.
   */
  applyPragmas?: boolean;
}

let cachedModule: Promise<WasmSqliteModule> | undefined;

/** Imports `di-framework:sqlite/database@0.1.0`, provided by the composed host component. */
export function loadWasmSqliteModule(): Promise<WasmSqliteModule> {
  if (!cachedModule) {
    cachedModule = import('di-framework:sqlite/database@0.1.0')
      .then((module) => module as unknown as WasmSqliteModule)
      .catch((error) => {
        cachedModule = undefined;
        throw new Error(
          `The ${WASM_SQLITE_MODULE_ID} import is unavailable in this runtime; compose the component with the di-framework SQLite provider`,
          { cause: error },
        );
      });
  }
  return cachedModule;
}

/** Statements that enforce the WIT durability contract on an open connection. */
export function wasmSqlitePragmas(options: WasmSqliteOpenOptions = {}): string[] {
  const journalMode = options.journalMode ?? WASM_SQLITE_DEFAULT_JOURNAL_MODE;
  const synchronous = options.synchronous ?? WASM_SQLITE_DEFAULT_SYNC_MODE;
  const pragmas = [
    `PRAGMA journal_mode = ${journalMode.toUpperCase()};`,
    `PRAGMA synchronous = ${synchronous.toUpperCase()};`,
  ];
  if (options.busyTimeoutMs !== undefined) {
    pragmas.push(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))};`);
  }
  if (options.foreignKeys !== undefined) {
    pragmas.push(`PRAGMA foreign_keys = ${options.foreignKeys ? 'ON' : 'OFF'};`);
  }
  return pragmas;
}

/**
 * Opens (or creates) a SQLite database through the Wasm host and adapts it to
 * `SqlDatabase`. Keep one handle per file and let it serialize transactions.
 */
export async function createWasmSqliteDatabase(
  path: string,
  options: WasmSqliteDatabaseOptions = {},
): Promise<SqlDatabase> {
  const { module: providedModule, loadModule, applyPragmas, ...openOptions } = options;
  const module = providedModule ?? (await (loadModule ?? loadWasmSqliteModule)());
  const resolvedOpenOptions: WasmSqliteOpenOptions = {
    create: openOptions.create ?? true,
    readOnly: openOptions.readOnly ?? false,
    synchronous: openOptions.synchronous ?? WASM_SQLITE_DEFAULT_SYNC_MODE,
    journalMode: openOptions.journalMode ?? WASM_SQLITE_DEFAULT_JOURNAL_MODE,
    ...(openOptions.busyTimeoutMs !== undefined
      ? { busyTimeoutMs: openOptions.busyTimeoutMs }
      : {}),
    ...(openOptions.foreignKeys !== undefined ? { foreignKeys: openOptions.foreignKeys } : {}),
  };
  const connection = await call(() => module.open(path, resolvedOpenOptions));
  const database = createSqlDatabaseFromWasmConnection(connection);
  if (applyPragmas !== false) {
    try {
      for (const pragma of wasmSqlitePragmas(resolvedOpenOptions)) {
        await database.exec(pragma);
      }
    } catch (error) {
      try {
        await database.close?.();
      } catch {}
      throw error;
    }
  }
  return database;
}

registerSqliteOpener('wasm', (path) => createWasmSqliteDatabase(path));
