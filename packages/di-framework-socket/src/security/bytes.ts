import { strictDecoder } from './webcrypto.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const TRAILING_BITS: Record<number, number> = { 2: 4, 3: 2 };

export class EncodingError extends Error {
  override readonly name = 'EncodingError';
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`randomBytes length must be a positive integer, received ${length}`);
  }
  if (length > 65_536) {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 65_536) {
      crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65_536, length)));
    }
    return out;
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Overwrite a buffer (best-effort; JS may retain copies). */
export function zeroize(bytes: Uint8Array | undefined | null): void {
  if (!bytes) return;
  bytes.fill(0);
}

export function base64UrlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(chunk >>> 18) & 63]! +
      ALPHABET[(chunk >>> 12) & 63]! +
      ALPHABET[(chunk >>> 6) & 63]! +
      ALPHABET[chunk & 63]!;
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i]! << 16;
    out += ALPHABET[(chunk >>> 18) & 63]! + ALPHABET[(chunk >>> 12) & 63]!;
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      ALPHABET[(chunk >>> 18) & 63]! +
      ALPHABET[(chunk >>> 12) & 63]! +
      ALPHABET[(chunk >>> 6) & 63]!;
  }

  return out;
}

export function base64UrlDecode(input: string): Uint8Array {
  const length = input.length;
  if (length % 4 === 1) {
    throw new EncodingError(`Invalid base64url length ${length}`);
  }

  const remainder = length % 4;
  const byteLength = ((length - remainder) / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
  const out = new Uint8Array(byteLength);

  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code]! : -1;
    if (value < 0) {
      throw new EncodingError(`Invalid base64url character at index ${i}`);
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (accumulator >>> bits) & 0xff;
    }
  }

  const expectedZeroBits = TRAILING_BITS[remainder];
  if (expectedZeroBits !== undefined && (accumulator & ((1 << expectedZeroBits) - 1)) !== 0) {
    throw new EncodingError('Non-canonical base64url: trailing bits are not zero');
  }

  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return strictDecoder().decode(bytes);
}

/** Big-endian uint64 as 8 bytes (counter for AAD). */
export function u64Be(n: number | bigint): Uint8Array {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${n}`);
  }
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function readU64Be(bytes: Uint8Array, offset = 0): bigint {
  if (bytes.length < offset + 8) throw new RangeError('u64 read past end');
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i]!);
  return v;
}
