/**
 * Web Cryptography API parameter types.
 *
 * The repo compiles with `lib: ["ESNext"]` and no `DOM`, and Bun's ambient types
 * supply the runtime globals (`crypto`, `CryptoKey`, `Request`) but not every
 * WebCrypto *parameter* interface. Declaring the handful we use keeps this
 * package compiling identically under the root build and standalone, without
 * pulling the whole DOM lib into a package that never touches a document.
 *
 * These mirror the W3C Web Cryptography API definitions and are structurally
 * compatible with the DOM lib's versions, so nothing breaks for a consumer whose
 * own tsconfig does include `DOM`.
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
  /**
   * WebCrypto algorithm parameters vary per algorithm and are passed inline at
   * call sites, so the base type stays open rather than forcing a cast on every
   * `{ name: 'AES-GCM', iv }` literal.
   */
  [parameter: string]: unknown;
}

export type AlgorithmIdentifier = string | Algorithm;

export interface HmacImportParams extends Algorithm {
  hash: AlgorithmIdentifier;
  length?: number;
}

export interface EcKeyImportParams extends Algorithm {
  namedCurve?: string;
}

export interface RsaHashedImportParams extends Algorithm {
  hash: AlgorithmIdentifier;
}

export interface RsaHashedKeyGenParams extends RsaHashedImportParams {
  modulusLength: number;
  publicExponent: Uint8Array;
}

export interface RsaPssParams extends Algorithm {
  saltLength: number;
}

export interface EcdsaParams extends Algorithm {
  hash: AlgorithmIdentifier;
}

export interface HkdfParams extends Algorithm {
  hash: AlgorithmIdentifier;
  salt: BufferSource;
  info: BufferSource;
}

export interface Pbkdf2Params extends Algorithm {
  hash: AlgorithmIdentifier;
  salt: BufferSource;
  iterations: number;
}

export interface AesGcmParams extends Algorithm {
  iv: BufferSource;
  additionalData?: BufferSource;
  tagLength?: number;
}

/**
 * The subset of `SubtleCrypto` this package calls.
 *
 * Typed loosely on purpose: every WebCrypto implementation disagrees slightly
 * about parameter unions, and a precise signature here would only produce casts
 * at every call site.
 */
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

/** `crypto.subtle`, narrowed to {@link SubtleLike}. */
export const subtle = crypto.subtle as unknown as SubtleLike;

/** `Uint8Array` as a `BufferSource`, bridging TS's ArrayBuffer/ArrayBufferView split. */
export function buf(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/**
 * `TextDecoder` that rejects malformed input.
 *
 * `ignoreBOM` is passed explicitly because Bun's ambient `TextDecoder` types
 * mark it required, and a decoder that silently strips a BOM would let the bytes
 * we parsed differ from the bytes we hashed.
 */
export function strictDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
}
