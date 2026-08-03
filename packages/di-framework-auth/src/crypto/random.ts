import { base64UrlEncode } from './base64url.ts';

/**
 * Cryptographically secure randomness, sourced from the Web Crypto API
 * (`crypto.getRandomValues`, W3C Web Cryptography API §11).
 */

/**
 * NIST SP 800-63B §7.1 requires session identifiers to carry at least 64 bits of
 * entropy. We floor at 16 bytes (128 bits) and default to 32 (256 bits), because
 * the cost of a longer opaque token is a few bytes on the wire and the cost of a
 * short one is a guessable session.
 */
const MIN_TOKEN_BYTES = 16;
const DEFAULT_TOKEN_BYTES = 32;

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`randomBytes length must be a positive integer, received ${length}`);
  }
  // getRandomValues is capped at 65_536 bytes per call by the spec.
  if (length > 65_536) {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 65_536) {
      crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65_536, length)));
    }
    return out;
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * A high-entropy opaque token, base64url encoded.
 *
 * Used for session ids, refresh tokens, API keys, OAuth `state`/`nonce`, and
 * WebAuthn challenges — every secret in this package that is *not* user-chosen.
 */
export function randomToken(bytes: number = DEFAULT_TOKEN_BYTES): string {
  if (bytes < MIN_TOKEN_BYTES) {
    throw new RangeError(
      `randomToken requires at least ${MIN_TOKEN_BYTES} bytes of entropy, received ${bytes}`,
    );
  }
  return base64UrlEncode(randomBytes(bytes));
}

/** RFC 4122 v4 identifier, for non-secret ids (session family ids, record keys). */
export function randomId(): string {
  return crypto.randomUUID();
}
