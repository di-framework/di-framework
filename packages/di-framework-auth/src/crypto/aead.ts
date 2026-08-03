import { base64UrlDecode, base64UrlEncode } from './base64url.ts';
import { concatBytes } from './hash.ts';
import { randomBytes } from './random.ts';
import { buf, strictDecoder, subtle } from './webcrypto.ts';

/**
 * AES-256-GCM (NIST SP 800-38D) for encrypting values that must round-trip
 * through a client — encrypted cookie payloads, OAuth `returnTo` targets.
 *
 * Wire format: `v1.<base64url(nonce ‖ ciphertext ‖ tag)>`.
 *
 * SP 800-38D §8.3 caps a random 96-bit IV at 2^32 invocations per key before the
 * collision probability becomes non-negligible. That is comfortably beyond the
 * lifetime of a rotated cookie key, but it is the reason `purpose` is bound as
 * additional authenticated data rather than folded into the key: distinct
 * purposes get distinct AAD, so a ciphertext minted for one can never be
 * accepted by another even if the same key is used.
 */

/** 96 bits — the only IV length for which GCM's security proof is tight. */
const NONCE_BYTES = 12;
const VERSION = 'v1';

export class AeadError extends Error {
  override readonly name = 'AeadError';
}

function aad(purpose: string): Uint8Array {
  return new TextEncoder().encode(`${VERSION}:${purpose}`);
}

/** Encrypt `plaintext` under `key`, binding it to `purpose`. */
export async function seal(
  key: CryptoKey,
  purpose: string,
  plaintext: Uint8Array | string,
): Promise<string> {
  const bytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(aad(purpose)),
      },
      key,
      buf(bytes),
    ),
  );
  return `${VERSION}.${base64UrlEncode(concatBytes(nonce, ciphertext))}`;
}

/**
 * Decrypt a value produced by {@link seal}.
 *
 * Returns `null` for any failure — wrong version, malformed encoding, wrong
 * purpose, tampered ciphertext. Callers must not distinguish these cases to the
 * client; the AEAD tag failing and the version being unrecognised are equally
 * "this token is not valid".
 */
export async function open(
  key: CryptoKey,
  purpose: string,
  sealed: string,
): Promise<Uint8Array | null> {
  const separator = sealed.indexOf('.');
  if (separator < 0 || sealed.slice(0, separator) !== VERSION) return null;

  let raw: Uint8Array;
  try {
    raw = base64UrlDecode(sealed.slice(separator + 1));
  } catch {
    return null;
  }
  if (raw.length <= NONCE_BYTES) return null;

  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(raw.subarray(0, NONCE_BYTES)),
        additionalData: buf(aad(purpose)),
      },
      key,
      buf(raw.subarray(NONCE_BYTES)),
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

/** {@link seal} for JSON values. */
export async function sealJson(key: CryptoKey, purpose: string, value: unknown): Promise<string> {
  return seal(key, purpose, JSON.stringify(value));
}

/** {@link open} for JSON values. Returns `null` when decryption or parsing fails. */
export async function openJson<T>(
  key: CryptoKey,
  purpose: string,
  sealed: string,
): Promise<T | null> {
  const plaintext = await open(key, purpose, sealed);
  if (!plaintext) return null;
  try {
    return JSON.parse(strictDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}
