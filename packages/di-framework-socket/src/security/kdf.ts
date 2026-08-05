import { buf, subtle } from './webcrypto.ts';

/** Domain-separation labels for HKDF. Never reuse a label for a second purpose. */
export const SOCKET_KDF_LABELS = {
  encryption: 'di-framework/socket:v1:encryption',
  confirmation: 'di-framework/socket:v1:confirmation',
} as const;

export type SocketKdfLabel = (typeof SOCKET_KDF_LABELS)[keyof typeof SOCKET_KDF_LABELS];

/** HKDF-SHA-256 (RFC 5869): derive `length` bytes for `label` from `ikm` and `salt`. */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  label: SocketKdfLabel | string,
  length = 32,
): Promise<Uint8Array> {
  if (length <= 0 || length > 255 * 32) {
    throw new RangeError(`HKDF length out of range: ${length}`);
  }
  const master = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
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
