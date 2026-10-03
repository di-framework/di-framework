/**
 * Encode and decode `wasmcloud:postgres` `pg-value` variants.
 *
 * The host binds parameters in binary. A text payload in a `uuid` or `boolean`
 * column is rejected, so callers tag values before `query`. Result cells use
 * the same variants. A query result is a column list, a row stream, and a
 * completion value; an `err` variant carries the provider failure.
 *
 * This module is not a `MigrationRunner` backend. Postgres schema history
 * stays in the guest. The runner's placeholders and transaction handle are
 * SQLite.
 */

/** A text `pg-value`. UUIDs are not text; see {@link pgValue}. */
export interface PgText {
  tag: 'text';
  val: string;
}

/** A tagged parameter or result cell from the `wasmcloud:postgres` binding. */
export interface PgParameter {
  tag: string;
  val?: unknown;
}

/**
 * Column type for {@link pgValue}. Inference is only the default: a small
 * number is `int4`, a float is `numeric`, and a UUID-shaped string is `uuid`.
 * Pass a tag, or use {@link text}, {@link uuid}, {@link int8}, or {@link float8},
 * when the column is a different Postgres type.
 */
export type PgTag =
  | 'text'
  | 'uuid'
  | 'bool'
  | 'int4'
  | 'int8'
  | 'float8'
  | 'numeric'
  | 'timestamp-tz'
  | 'bytea'
  | 'jsonb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

/** Tag a string as Postgres `text`, including a value that looks like a UUID. */
export function text(value: string): PgText {
  return { tag: 'text', val: value };
}

/** Tag a string as Postgres `uuid`. */
export function uuid(value: string): PgParameter {
  return { tag: 'uuid', val: value };
}

/**
 * Tag an integer as Postgres `int8` (`s64`). The payload stays a `bigint` so
 * values above 2^53 are not rounded.
 */
export function int8(value: bigint | number): PgParameter {
  if (typeof value === 'bigint') return int8Parameter(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return int8Parameter(BigInt(value));
  throw wrongType('int8');
}

/** Tag a finite number as Postgres `float8` (`hashable-f64`). */
export function float8(value: number): PgParameter {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw wrongType('float8');
  return { tag: 'float8', val: hashableF64(value) };
}

/**
 * Encode a repository parameter as a `pg-value`.
 *
 * Without `tag`, the JavaScript value picks a default: UUID-shaped strings
 * become `uuid`, integers in the int4 range become `int4`, other safe integers
 * become `int8`, and other finite numbers become `numeric`. The host binds in
 * binary, so that default is rejected when the column type differs. Pass `tag`
 * (or {@link text}, {@link uuid}, {@link int8}, {@link float8}) to name the column.
 */
export function pgValue(value: unknown, tag?: PgTag): PgParameter {
  if (value == null) return { tag: 'null' };
  if (tag !== undefined) return coerce(value, tag);
  return infer(value);
}

/** Normalize a binding failure, including an `err` variant, into an `Error`. */
export function postgresError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.startsWith('PostgreSQL')) return cause;
  const source = cause instanceof Error && 'payload' in cause ? cause.payload : cause;
  const code = nestedString(source, 'code');
  const message = nestedString(source, 'message') ?? scalarVal(source);
  const tag = tagOf(source);
  const labeled = tag !== undefined && tag !== 'err' && tag !== 'ok';
  const error = codedMessage(code, message, labeled ? tag : undefined);
  console.error(error.message);
  return error;
}

/** True when `error` is a Postgres unique violation (`23505`). */
export function isUniqueViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : '';
  return /^PostgreSQL 23505\b/.test(text) || text.toLowerCase().includes('duplicate key');
}

/** Turn one cell of a `pg-value` variant into a JSON value. */
export function pgScalar(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || !('tag' in value)) return value;
  const tagged = value as PgParameter;
  if (tagged.tag === 'null') return null;
  if (tagged.tag === 'varchar' || tagged.tag === 'text' || tagged.tag === 'name') {
    return characters(tagged.val);
  }
  if (tagged.tag === 'json' || tagged.tag === 'jsonb') {
    if (typeof tagged.val !== 'string') return tagged.val ?? null;
    try {
      return JSON.parse(tagged.val) as unknown;
    } catch {
      return tagged.val;
    }
  }
  if (tagged.tag === 'timestamp' || tagged.tag === 'timestamp-tz') return timestampIso(tagged.val);
  if (tagged.tag === 'bool' || tagged.tag === 'boolean') return tagged.val === true;
  if (
    tagged.tag === 'int8' ||
    tagged.tag === 'big-int' ||
    tagged.tag === 'bigserial' ||
    tagged.tag === 'serial8'
  ) {
    return jsonInt(tagged.val);
  }
  return tagged.val === undefined ? null : tagged.val;
}

function infer(value: unknown): PgParameter {
  if (typeof value === 'string') {
    return UUID.test(value) ? uuid(value) : text(value);
  }
  if (typeof value === 'boolean') return { tag: 'bool', val: value };
  if (typeof value === 'bigint') return int8(value);
  if (typeof value === 'number') return inferNumber(value);
  if (value instanceof Date) return { tag: 'timestamp-tz', val: timestampTz(value) };
  if (value instanceof Uint8Array) return { tag: 'bytea', val: [...value] };
  return { tag: 'jsonb', val: JSON.stringify(value) };
}

function inferNumber(value: number): PgParameter {
  if (!Number.isFinite(value)) throw new Error('PostgreSQL parameter is not a finite number');
  if (Number.isInteger(value)) {
    if (value >= INT4_MIN && value <= INT4_MAX) return { tag: 'int4', val: value };
    if (Number.isSafeInteger(value)) return int8(value);
    throw new Error('PostgreSQL int8 parameter is not an exact integer');
  }
  return { tag: 'numeric', val: String(value) };
}

function coerce(value: unknown, tag: PgTag): PgParameter {
  switch (tag) {
    case 'text':
      if (typeof value !== 'string') throw wrongType(tag);
      return text(value);
    case 'uuid':
      if (typeof value !== 'string') throw wrongType(tag);
      return uuid(value);
    case 'bool':
      if (typeof value !== 'boolean') throw wrongType(tag);
      return { tag: 'bool', val: value };
    case 'int4':
      return int4Parameter(value);
    case 'int8':
      if (typeof value !== 'bigint' && typeof value !== 'number') throw wrongType(tag);
      return int8(value);
    case 'float8':
      if (typeof value !== 'number') throw wrongType(tag);
      return float8(value);
    case 'numeric':
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw wrongType(tag);
        return { tag: 'numeric', val: String(value) };
      }
      if (typeof value === 'string') return { tag: 'numeric', val: value };
      throw wrongType(tag);
    case 'timestamp-tz':
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw wrongType(tag);
      return { tag: 'timestamp-tz', val: timestampTz(value) };
    case 'bytea':
      if (!(value instanceof Uint8Array)) throw wrongType(tag);
      return { tag: 'bytea', val: [...value] };
    case 'jsonb':
      return { tag: 'jsonb', val: typeof value === 'string' ? value : JSON.stringify(value) };
  }
}

function int4Parameter(value: unknown): PgParameter {
  if (typeof value === 'bigint') {
    if (value < BigInt(INT4_MIN) || value > BigInt(INT4_MAX)) throw wrongType('int4');
    return { tag: 'int4', val: Number(value) };
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < INT4_MIN ||
    value > INT4_MAX
  ) {
    throw wrongType('int4');
  }
  return { tag: 'int4', val: value };
}

function int8Parameter(value: bigint): PgParameter {
  if (value < INT8_MIN || value > INT8_MAX) {
    throw new Error('PostgreSQL int8 parameter is outside the signed 64-bit range');
  }
  return { tag: 'int8', val: value };
}

function wrongType(tag: string): Error {
  return new Error(`PostgreSQL ${tag} parameter has the wrong type`);
}

/** JSON number when `value` is an exact safe integer, otherwise a decimal string. */
function jsonInt(value: unknown): unknown {
  if (typeof value !== 'bigint') return value === undefined ? null : value;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) && BigInt(asNumber) === value ? asNumber : value.toString();
}

/** Throw when a batch result is an `err` variant. */
export function assertBatch(result: unknown): void {
  if (isErr(result)) throw postgresError(result);
}

/** Read columns and a row stream from a query result, or throw on `err`. */
export async function readRows(result: unknown): Promise<Record<string, unknown>[]> {
  const value = isOk(result) ? result.val : result;
  if (isErr(result)) throw postgresError(result);
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('PostgreSQL query returned an unexpected result');
  }
  const columns = value[0];
  const rawRows = await collect(value[1]);
  await finish(value[2]);
  return rawRows.map((row) => record(columns, row));
}

function codedMessage(
  code: string | undefined,
  message: string | undefined,
  tag: string | undefined,
): Error {
  if (code && message) return new Error(`PostgreSQL ${code} ${message}`);
  if (code) return new Error(`PostgreSQL ${code}`);
  if (tag && message) return new Error(`PostgreSQL ${tag} ${message}`);
  if (tag) return new Error(`PostgreSQL ${tag}`);
  if (message) return new Error(`PostgreSQL ${message}`);
  return new Error('PostgreSQL rejected the statement');
}

function isErr(result: unknown): result is { tag: 'err'; val?: unknown } {
  return isTag(result, 'err');
}

function isOk(result: unknown): result is { tag: 'ok'; val?: unknown } {
  return isTag(result, 'ok');
}

function isTag(result: unknown, tag: string): boolean {
  if (result == null || typeof result !== 'object') return false;
  return 'tag' in result && result.tag === tag;
}

async function collect(stream: unknown): Promise<unknown[]> {
  if (stream == null || typeof stream !== 'object') {
    throw new Error('PostgreSQL query did not return a row stream');
  }
  const rows: unknown[] = [];
  if (Symbol.asyncIterator in stream || Symbol.iterator in stream) {
    for await (const row of stream as AsyncIterable<unknown>) rows.push(row);
    return rows;
  }
  const readable = stream as { read?: (count?: number) => unknown };
  if (typeof readable.read !== 'function') {
    throw new Error('PostgreSQL query did not return a row stream');
  }
  let chunk: unknown = await readable.read(64);
  while (Array.isArray(chunk) && chunk.length > 0) {
    rows.push(...chunk);
    chunk = await readable.read(64);
  }
  return rows;
}

async function finish(done: unknown): Promise<void> {
  if (done == null) return;
  let completion: unknown = done;
  if (typeof done === 'object' && 'read' in done && typeof done.read === 'function') {
    completion = await (done.read as () => unknown)();
  } else if (typeof (done as Promise<unknown>).then === 'function') {
    completion = await (done as Promise<unknown>);
  }
  if (isErr(completion)) throw postgresError(completion);
}

function record(columns: unknown, row: unknown): Record<string, unknown> {
  if (!Array.isArray(columns) || !Array.isArray(row)) {
    throw new Error('PostgreSQL query returned an unexpected row');
  }
  const out: Record<string, unknown> = {};
  for (const [index, column] of columns.entries()) {
    if (typeof column === 'string') out[column] = pgScalar(row[index]);
  }
  return out;
}

/**
 * `num::Float::integer_decode` for `f64`: mantissa, exponent, sign.
 * The host rebuilds the value as `sign * mantissa * 2^exponent`.
 */
function hashableF64(value: number): [bigint, number, number] {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  const sign = raw >> 63n === 0n ? 1 : -1;
  let exponent = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & 0xfffffffffffffn;
  const mantissa = exponent === 0 ? fraction << 1n : fraction | (1n << 52n);
  exponent -= 1023 + 52;
  return [mantissa, exponent, sign];
}

function timestampTz(value: Date) {
  return {
    timestamp: {
      date: {
        tag: 'ymd',
        val: [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()],
      },
      time: {
        hour: value.getUTCHours(),
        min: value.getUTCMinutes(),
        sec: value.getUTCSeconds(),
        micro: Math.floor(value.getUTCMilliseconds() * 1000),
      },
    },
    offset: { tag: 'eastern-hemisphere-secs', val: 0 },
  };
}

function timestampIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null || typeof value !== 'object') return null;
  const wrapped = value as { timestamp?: unknown; val?: unknown };
  const timestamp = (wrapped.timestamp ?? wrapped.val) as
    | {
        date?: { tag?: string; val?: unknown };
        time?: { hour?: number; min?: number; sec?: number; micro?: number };
      }
    | undefined;
  if (timestamp == null || typeof timestamp !== 'object') return null;
  const date = timestamp.date;
  const ymd = date?.tag === 'ymd' && Array.isArray(date.val) ? date.val : undefined;
  if (ymd == null || ymd.length < 3) return null;
  const year = ymd[0];
  const month = ymd[1];
  const day = ymd[2];
  if (year === undefined || month === undefined || day === undefined) return null;
  const time = timestamp.time;
  const pad = (part: number, width = 2) => String(part).padStart(width, '0');
  const hour = pad(time?.hour ?? 0);
  const minute = pad(time?.min ?? 0);
  const second = pad(time?.sec ?? 0);
  const milli = pad(Math.floor((time?.micro ?? 0) / 1000), 3);
  return `${pad(Number(year), 4)}-${pad(Number(month))}-${pad(Number(day))}T${hour}:${minute}:${second}.${milli}Z`;
}

function characters(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isByteTuple(value)) return characters(value[1]);
  const bytes = byteList(value);
  if (!bytes) return null;
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function isByteTuple(value: unknown): value is [unknown, unknown] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (value[0] == null || typeof value[0] === 'number') &&
    typeof value[1] !== 'number'
  );
}

function byteList(value: unknown): number[] | undefined {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value;
  if (value == null || typeof value !== 'object') return undefined;
  const keys = Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right));
  if (keys.length === 0) return undefined;
  const record = value as Record<string, unknown>;
  return keys.map((key) => Number(record[key]));
}

function tagOf(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object' || !('tag' in value)) return undefined;
  return typeof value.tag === 'string' ? value.tag : undefined;
}

function scalarVal(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object' || !('val' in value)) return undefined;
  return typeof value.val === 'string' ? value.val : undefined;
}

function nestedString(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 6 || value == null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === 'string' && direct !== '') return direct;
  return nestedString(record.val, key, depth + 1);
}
