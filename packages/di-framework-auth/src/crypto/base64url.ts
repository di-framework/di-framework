/**
 * base64url (RFC 4648 §5) without padding.
 *
 * Decoding is deliberately strict: standard-alphabet characters (`+`, `/`),
 * padding, whitespace, and non-canonical trailing bits are all rejected. Lenient
 * base64 decoders are a signature-malleability source — two distinct strings that
 * decode to the same bytes let an attacker mutate a token that has already been
 * matched against a replay cache.
 */
import { strictDecoder } from './webcrypto.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup table; -1 marks a character outside the base64url alphabet. */
const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Number of low bits that must be zero for a given remainder length. */
const TRAILING_BITS: Record<number, number> = { 2: 4, 3: 2 };

export class Base64UrlError extends Error {
  override readonly name = 'Base64UrlError';
}

/** Encode bytes as unpadded base64url. */
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

/**
 * Decode unpadded base64url.
 *
 * @throws {Base64UrlError} on padding, standard-alphabet characters, whitespace,
 *   a length of 1 mod 4, or non-zero trailing bits.
 */
export function base64UrlDecode(input: string): Uint8Array {
  const length = input.length;
  if (length % 4 === 1) {
    throw new Base64UrlError(`Invalid base64url length ${length} (1 mod 4 is unrepresentable)`);
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
      throw new Base64UrlError(
        `Invalid base64url character ${JSON.stringify(input[i])} at index ${i}`,
      );
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (accumulator >>> bits) & 0xff;
    }
  }

  // Canonical form: the bits that fall off the end of the last group must be zero.
  const expectedZeroBits = TRAILING_BITS[remainder];
  if (expectedZeroBits !== undefined && (accumulator & ((1 << expectedZeroBits) - 1)) !== 0) {
    throw new Base64UrlError('Non-canonical base64url: trailing bits are not zero');
  }

  return out;
}

/** Encode a UTF-8 string as base64url. */
export function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

/** Decode base64url to a UTF-8 string. Invalid UTF-8 throws. */
export function base64UrlDecodeString(input: string): string {
  return strictDecoder().decode(base64UrlDecode(input));
}

/** True when `input` is valid, canonical, unpadded base64url. */
export function isBase64Url(input: string): boolean {
  try {
    base64UrlDecode(input);
    return true;
  } catch {
    return false;
  }
}
