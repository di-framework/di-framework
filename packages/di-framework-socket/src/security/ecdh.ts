import { base64UrlDecode, base64UrlEncode } from './bytes.ts';
import { buf, subtle } from './webcrypto.ts';

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface EphemeralEcdhKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  publicKeyB64: string;
}

/** Generate an ephemeral P-256 ECDH key pair (forward secrecy per session). */
export async function generateEcdhKeyPair(): Promise<EphemeralEcdhKeyPair> {
  const pair = (await subtle.generateKey(ECDH_P256, false, ['deriveBits'])) as CryptoKeyPair;
  const exported = await subtle.exportKey('raw', pair.publicKey);
  const raw = new Uint8Array(exported as ArrayBuffer);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyB64: base64UrlEncode(raw),
  };
}

/** Import a peer's uncompressed P-256 public key from base64url. */
export async function importEcdhPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(publicKeyB64);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('Invalid ECDH P-256 public key (expected uncompressed 65-byte point)');
  }
  return subtle.importKey('raw', buf(raw), ECDH_P256, false, []);
}

/** Derive 256 bits of shared secret via ECDH. */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Uint8Array> {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256);
  return new Uint8Array(bits);
}
