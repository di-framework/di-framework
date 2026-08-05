/**
 * A minimal CBOR decoder (RFC 8949), scoped to what WebAuthn needs: attestation
 * objects and COSE keys.
 *
 * This parses **unauthenticated, attacker-controlled bytes** — an attestation
 * object arrives straight from an untrusted client, before any signature has
 * been checked. The depth, size, and element-count limits below are therefore
 * load-bearing controls, not defensive decoration: without them, a forty-byte
 * input can describe a structure that exhausts memory or blows the stack.
 *
 * The decoder enforces **CTAP2 canonical CBOR** (CTAP 2.1 §6.3), which is what
 * authenticators are required to emit:
 * - definite lengths only — indefinite-length items are rejected;
 * - shortest-form integer encoding;
 * - map keys sorted, and no duplicates.
 *
 * Rejecting non-canonical input matters beyond tidiness: two encodings of the
 * same map would produce two distinct byte strings that verify against the same
 * signature, which is signature malleability.
 */
import { strictDecoder } from '../crypto/webcrypto.ts';

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

export interface CborDecodeOptions {
  /** Nesting limit. Default 16 — WebAuthn structures are three or four deep. */
  maxDepth?: number;
  /** Cap on array/map element counts. Default 1024. */
  maxElements?: number;
  /** Cap on any single byte or text string. Default 64 KiB. */
  maxStringBytes?: number;
}

export class CborError extends Error {
  override readonly name = 'CborError';
}

const DEFAULTS: Required<CborDecodeOptions> = {
  maxDepth: 16,
  maxElements: 1024,
  maxStringBytes: 65_536,
};

interface Cursor {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset: number;
  readonly limits: Required<CborDecodeOptions>;
}

function need(cursor: Cursor, count: number): void {
  if (cursor.offset + count > cursor.bytes.length) {
    throw new CborError(
      `Truncated CBOR: needed ${count} bytes at offset ${cursor.offset}, ${cursor.bytes.length - cursor.offset} remain`,
    );
  }
}

/**
 * Read a major type's argument.
 *
 * The shortest-form check is what makes the encoding canonical: `0x18 0x05`
 * (one-byte argument holding 5) and `0x05` (immediate 5) both mean five, and
 * accepting both would make the encoding ambiguous.
 */
function readArgument(cursor: Cursor, additional: number): number | bigint {
  if (additional < 24) return additional;

  switch (additional) {
    case 24: {
      need(cursor, 1);
      const value = cursor.view.getUint8(cursor.offset);
      cursor.offset += 1;
      if (value < 24)
        throw new CborError('Non-canonical CBOR: 1-byte argument should be immediate');
      return value;
    }
    case 25: {
      need(cursor, 2);
      const value = cursor.view.getUint16(cursor.offset, false);
      cursor.offset += 2;
      if (value <= 0xff)
        throw new CborError('Non-canonical CBOR: 2-byte argument fits in fewer bytes');
      return value;
    }
    case 26: {
      need(cursor, 4);
      const value = cursor.view.getUint32(cursor.offset, false);
      cursor.offset += 4;
      if (value <= 0xffff)
        throw new CborError('Non-canonical CBOR: 4-byte argument fits in fewer bytes');
      return value;
    }
    case 27: {
      need(cursor, 8);
      const value = cursor.view.getBigUint64(cursor.offset, false);
      cursor.offset += 8;
      if (value <= 0xffff_ffffn) {
        throw new CborError('Non-canonical CBOR: 8-byte argument fits in fewer bytes');
      }
      return value;
    }
    case 31:
      // CTAP2 canonical CBOR forbids indefinite lengths, and supporting them
      // would mean a length that cannot be validated before allocation.
      throw new CborError('Indefinite-length CBOR items are not accepted');
    default:
      throw new CborError(`Reserved CBOR additional information ${additional}`);
  }
}

function asLength(value: number | bigint, limit: number, what: string): number {
  if (typeof value === 'bigint' || value > limit) {
    throw new CborError(`CBOR ${what} length ${value} exceeds the limit of ${limit}`);
  }
  return value;
}

/** Compare two encoded map keys per the CTAP2 canonical ordering (CTAP 2.1 §6.3). */
function canonicalKeyOrder(a: CborValue, b: CborValue): number {
  const rank = (value: CborValue): number => {
    if (typeof value === 'number' || typeof value === 'bigint') return value >= 0 ? 0 : 1;
    if (typeof value === 'string') return 3;
    return 4;
  };
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA - rankB;

  if (typeof a === 'number' && typeof b === 'number') {
    // Within a sign class, shorter encodings sort first; for the small integers
    // WebAuthn uses this is equivalent to magnitude order.
    return Math.abs(a) - Math.abs(b);
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return 0;
}

function decodeValue(cursor: Cursor, depth: number): CborValue {
  if (depth > cursor.limits.maxDepth) {
    throw new CborError(`CBOR nesting exceeds the depth limit of ${cursor.limits.maxDepth}`);
  }

  need(cursor, 1);
  const initial = cursor.bytes[cursor.offset++]!;
  const majorType = initial >> 5;
  const additional = initial & 0x1f;

  switch (majorType) {
    case 0: {
      const value = readArgument(cursor, additional);
      return typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value;
    }
    case 1: {
      const value = readArgument(cursor, additional);
      if (typeof value === 'bigint') return -1n - value;
      return -1 - value;
    }
    case 2: {
      const length = asLength(
        readArgument(cursor, additional),
        cursor.limits.maxStringBytes,
        'byte string',
      );
      need(cursor, length);
      // `slice`, not `subarray`: the result outlives this call and must not
      // alias the input buffer.
      const value = cursor.bytes.slice(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      return value;
    }
    case 3: {
      const length = asLength(
        readArgument(cursor, additional),
        cursor.limits.maxStringBytes,
        'text string',
      );
      need(cursor, length);
      const raw = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      try {
        return strictDecoder().decode(raw);
      } catch {
        throw new CborError('CBOR text string is not valid UTF-8');
      }
    }
    case 4: {
      const count = asLength(readArgument(cursor, additional), cursor.limits.maxElements, 'array');
      const items: CborValue[] = [];
      for (let i = 0; i < count; i++) items.push(decodeValue(cursor, depth + 1));
      return items;
    }
    case 5: {
      const count = asLength(readArgument(cursor, additional), cursor.limits.maxElements, 'map');
      const map = new Map<CborValue, CborValue>();
      let previousKey: CborValue | undefined;
      for (let i = 0; i < count; i++) {
        const key = decodeValue(cursor, depth + 1);
        if (typeof key === 'object' && key !== null) {
          throw new CborError('CBOR map keys must be integers or text strings');
        }
        if (map.has(key)) {
          // A duplicate key means two readers can disagree about the map's
          // contents — one takes the first, one takes the last.
          throw new CborError(`Duplicate CBOR map key ${JSON.stringify(String(key))}`);
        }
        if (previousKey !== undefined && canonicalKeyOrder(previousKey, key) > 0) {
          throw new CborError('Non-canonical CBOR: map keys are not in canonical order');
        }
        previousKey = key;
        map.set(key, decodeValue(cursor, depth + 1));
      }
      return map;
    }
    case 6:
      // Tags carry semantics we would have to interpret; nothing in WebAuthn
      // uses them, so accepting one could only ever be a surprise.
      throw new CborError('CBOR tags are not accepted');
    case 7:
      switch (additional) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 25:
        case 26:
        case 27:
          throw new CborError('CBOR floating-point values are not accepted');
        default:
          throw new CborError(`Unsupported CBOR simple value ${additional}`);
      }
    default:
      throw new CborError(`Unknown CBOR major type ${majorType}`);
  }
}

/** Decode one CBOR item, reporting how many bytes it occupied. */
export function decodeCborAt(
  bytes: Uint8Array,
  offset = 0,
  options: CborDecodeOptions = {},
): { value: CborValue; bytesRead: number } {
  const cursor: Cursor = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset,
    limits: { ...DEFAULTS, ...options },
  };
  const value = decodeValue(cursor, 0);
  return { value, bytesRead: cursor.offset - offset };
}

/**
 * Decode exactly one CBOR item from `bytes`.
 *
 * @throws {CborError} when bytes remain after the item. Trailing data is a
 *   parser-differential vector: one implementation reads the first item and
 *   stops, another reads the last, and the two disagree about what was signed.
 */
export function decodeCbor(bytes: Uint8Array, options: CborDecodeOptions = {}): CborValue {
  const { value, bytesRead } = decodeCborAt(bytes, 0, options);
  if (bytesRead !== bytes.length) {
    throw new CborError(`Trailing CBOR data: ${bytes.length - bytesRead} unread bytes`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Typed accessors                                                            */
/* -------------------------------------------------------------------------- */

export function asCborMap(value: CborValue, what: string): Map<CborValue, CborValue> {
  if (!(value instanceof Map)) throw new CborError(`${what} is not a CBOR map`);
  return value;
}

export function cborBytes(
  map: Map<CborValue, CborValue>,
  key: CborValue,
  what: string,
): Uint8Array {
  const value = map.get(key);
  if (!(value instanceof Uint8Array))
    throw new CborError(`${what} is missing or is not a byte string`);
  return value;
}

export function cborText(map: Map<CborValue, CborValue>, key: CborValue, what: string): string {
  const value = map.get(key);
  if (typeof value !== 'string') throw new CborError(`${what} is missing or is not a text string`);
  return value;
}

export function cborInt(map: Map<CborValue, CborValue>, key: CborValue, what: string): number {
  const value = map.get(key);
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new CborError(`${what} is missing or is not an integer`);
  return value;
}
