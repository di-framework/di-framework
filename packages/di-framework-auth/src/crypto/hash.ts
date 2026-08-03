import { base64UrlEncode } from './base64url.ts';
import { buf, subtle } from './webcrypto.ts';

/** SHA-2 digests (FIPS 180-4) over the Web Crypto API. */

export type DigestAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

export async function digest(
  algorithm: DigestAlgorithm,
  data: Uint8Array | string,
): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await subtle.digest(algorithm, buf(bytes)));
}

export function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return digest('SHA-256', data);
}

export function sha384(data: Uint8Array | string): Promise<Uint8Array> {
  return digest('SHA-384', data);
}

export function sha512(data: Uint8Array | string): Promise<Uint8Array> {
  return digest('SHA-512', data);
}

/**
 * The storage form for high-entropy secrets: session ids, refresh tokens, and
 * API keys.
 *
 * These are 256-bit random values, so there is no dictionary to attack and a
 * slow password KDF buys nothing — it would only turn every authenticated
 * request into a six-hundred-thousand-iteration CPU burn. A plain SHA-256 means
 * a dump of the session store is not a dump of live sessions, which is the
 * property we actually want. Password KDFs are for *user-chosen* secrets only;
 * see `./password-hasher.ts`.
 */
export async function hashSecret(secret: string): Promise<string> {
  return base64UrlEncode(await sha256(secret));
}

/** Concatenate byte arrays into one buffer. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
