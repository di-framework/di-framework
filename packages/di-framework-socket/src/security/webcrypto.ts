/**
 * Web Cryptography API parameter types.
 *
 * Same approach as `@di-framework/auth`: the monorepo compiles with
 * `lib: ["ESNext"]` and no DOM, so we declare the parameter shapes we need
 * without pulling in document APIs.
 */

export type KeyUsage =
  | 'encrypt'
  | 'decrypt'
  | 'sign'
  | 'verify'
  | 'deriveKey'
  | 'deriveBits'
  | 'wrapKey'
  | 'unwrapKey';

export interface Algorithm {
  name: string;
  [parameter: string]: unknown;
}

export type AlgorithmIdentifier = string | Algorithm;

/** Mirrors the DOM lib's `BufferSource`, which `lib: ["ESNext"]` does not supply. */
export type BufferSource = ArrayBufferView | ArrayBuffer;

/**
 * Mirrors the DOM lib's `JsonWebKey` (RFC 7517), which `lib: ["ESNext"]` does not
 * supply. Structurally compatible, so a consumer whose tsconfig includes `DOM`
 * can pass its own `JsonWebKey` here.
 */
export interface JsonWebKey {
  alg?: string;
  crv?: string;
  d?: string;
  dp?: string;
  dq?: string;
  e?: string;
  ext?: boolean;
  k?: string;
  key_ops?: string[];
  kty?: string;
  n?: string;
  p?: string;
  q?: string;
  qi?: string;
  use?: string;
  x?: string;
  y?: string;
}

export interface SubtleLike {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: BufferSource | JsonWebKey,
    algorithm: AlgorithmIdentifier,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey>;
  generateKey(
    algorithm: AlgorithmIdentifier,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey | CryptoKeyPair>;
  deriveBits(
    algorithm: AlgorithmIdentifier,
    baseKey: CryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
  sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  verify(
    algorithm: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean>;
  encrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  decrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
}

export const subtle = crypto.subtle as unknown as SubtleLike;

/** `Uint8Array` as a `BufferSource`, bridging ArrayBuffer / ArrayBufferView typing. */
export function buf(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

export function strictDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
}
