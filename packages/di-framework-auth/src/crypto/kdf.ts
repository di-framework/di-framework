/**
 * HKDF-SHA-256 (RFC 5869, approved by NIST SP 800-56C rev2).
 *
 * One master secret goes in; a distinct key per purpose comes out. Reusing a
 * single raw secret directly as the cookie AEAD key, the CSRF HMAC key, and the
 * HS256 signing key would let a weakness in any one construction bleed into the
 * others. The `info` label is what keeps them independent.
 */
import { buf, type KeyUsage, subtle } from './webcrypto.ts';

/** Domain-separation labels. Never reuse one for a second purpose. */
export const KDF_LABELS = {
  cookieAead: 'di-framework/auth:v1:cookie-aead',
  csrf: 'di-framework/auth:v1:csrf',
  hs256: 'di-framework/auth:v1:hs256',
  apiKey: 'di-framework/auth:v1:api-key',
} as const;

export type KdfLabel = (typeof KDF_LABELS)[keyof typeof KDF_LABELS] | (string & {});

/** Master secrets shorter than this are rejected — 256 bits or nothing. */
export const MIN_SECRET_BYTES = 32;

export function toSecretBytes(secret: Uint8Array | string): Uint8Array {
  const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new RangeError(
      `Auth master secret must be at least ${MIN_SECRET_BYTES} bytes (${MIN_SECRET_BYTES * 8} bits); received ${bytes.length}`,
    );
  }
  return bytes;
}

/** Derive `length` raw bytes for `label` from the master secret. */
export async function hkdf(
  secret: Uint8Array | string,
  label: KdfLabel,
  length = 32,
  salt: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
  const master = await subtle.importKey('raw', buf(toSecretBytes(secret)), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: buf(salt),
      info: buf(new TextEncoder().encode(label)),
    },
    master,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Derive an AES-256-GCM key for `label`. */
export async function deriveAesKey(
  secret: Uint8Array | string,
  label: KdfLabel,
): Promise<CryptoKey> {
  return subtle.importKey(
    'raw',
    (await hkdf(secret, label, 32)) as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Derive an HMAC-SHA-256 key for `label`. */
export async function deriveHmacKey(
  secret: Uint8Array | string,
  label: KdfLabel,
  usages: KeyUsage[] = ['sign', 'verify'],
): Promise<CryptoKey> {
  return subtle.importKey(
    'raw',
    (await hkdf(secret, label, 32)) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}
