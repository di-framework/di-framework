/**
 * JWS algorithm registry (RFC 7518, plus RFC 8037 for EdDSA).
 *
 * Every algorithm here is NIST-approved: HMAC-SHA-2 (FIPS 198-1), ECDSA over
 * P-256/384/521 (FIPS 186-5), RSASSA-PKCS1-v1_5 and RSA-PSS (FIPS 186-5), and
 * Ed25519 (FIPS 186-5 §7, approved 2023).
 *
 * `none` is not modelled at all. It is not an algorithm this package can be
 * asked for, which is stronger than checking for it at verification time.
 */
import {
  type AlgorithmIdentifier,
  buf,
  type EcdsaParams,
  type EcKeyImportParams,
  type HmacImportParams,
  type RsaHashedImportParams,
  type RsaPssParams,
  subtle,
} from '../crypto/webcrypto.ts';

export type SignatureAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'EdDSA';

export interface AlgorithmSpec {
  /** WebCrypto import/sign parameters. */
  readonly importParams:
    | AlgorithmIdentifier
    | RsaHashedImportParams
    | EcKeyImportParams
    | HmacImportParams;
  readonly signParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  readonly kty: 'oct' | 'EC' | 'RSA' | 'OKP';
  readonly curve?: string;
  /** Raw ECDSA signature length, for DER conversion. */
  readonly ecdsaSignatureBytes?: number;
  readonly digest: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

export const ALGORITHMS: Readonly<Record<SignatureAlgorithm, AlgorithmSpec>> = {
  HS256: {
    importParams: { name: 'HMAC', hash: 'SHA-256' },
    signParams: 'HMAC',
    kty: 'oct',
    digest: 'SHA-256',
  },
  HS384: {
    importParams: { name: 'HMAC', hash: 'SHA-384' },
    signParams: 'HMAC',
    kty: 'oct',
    digest: 'SHA-384',
  },
  HS512: {
    importParams: { name: 'HMAC', hash: 'SHA-512' },
    signParams: 'HMAC',
    kty: 'oct',
    digest: 'SHA-512',
  },
  ES256: {
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    signParams: { name: 'ECDSA', hash: 'SHA-256' },
    kty: 'EC',
    curve: 'P-256',
    ecdsaSignatureBytes: 64,
    digest: 'SHA-256',
  },
  ES384: {
    importParams: { name: 'ECDSA', namedCurve: 'P-384' },
    signParams: { name: 'ECDSA', hash: 'SHA-384' },
    kty: 'EC',
    curve: 'P-384',
    ecdsaSignatureBytes: 96,
    digest: 'SHA-384',
  },
  ES512: {
    importParams: { name: 'ECDSA', namedCurve: 'P-521' },
    signParams: { name: 'ECDSA', hash: 'SHA-512' },
    kty: 'EC',
    curve: 'P-521',
    ecdsaSignatureBytes: 132,
    digest: 'SHA-512',
  },
  RS256: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    signParams: 'RSASSA-PKCS1-v1_5',
    kty: 'RSA',
    digest: 'SHA-256',
  },
  RS384: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    signParams: 'RSASSA-PKCS1-v1_5',
    kty: 'RSA',
    digest: 'SHA-384',
  },
  RS512: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    signParams: 'RSASSA-PKCS1-v1_5',
    kty: 'RSA',
    digest: 'SHA-512',
  },
  PS256: {
    importParams: { name: 'RSA-PSS', hash: 'SHA-256' },
    signParams: { name: 'RSA-PSS', saltLength: 32 },
    kty: 'RSA',
    digest: 'SHA-256',
  },
  PS384: {
    importParams: { name: 'RSA-PSS', hash: 'SHA-384' },
    signParams: { name: 'RSA-PSS', saltLength: 48 },
    kty: 'RSA',
    digest: 'SHA-384',
  },
  PS512: {
    importParams: { name: 'RSA-PSS', hash: 'SHA-512' },
    signParams: { name: 'RSA-PSS', saltLength: 64 },
    kty: 'RSA',
    digest: 'SHA-512',
  },
  EdDSA: {
    importParams: { name: 'Ed25519' },
    signParams: 'Ed25519',
    kty: 'OKP',
    curve: 'Ed25519',
    digest: 'SHA-512',
  },
};

export function isSignatureAlgorithm(value: unknown): value is SignatureAlgorithm {
  return typeof value === 'string' && Object.hasOwn(ALGORITHMS, value);
}

export function algorithmSpec(algorithm: SignatureAlgorithm): AlgorithmSpec {
  const spec = ALGORITHMS[algorithm];
  if (!spec) throw new Error(`Unsupported JWS algorithm '${algorithm}'`);
  return spec;
}

/**
 * The default for newly generated signing keys.
 *
 * ES256 rather than EdDSA: Ed25519 is the better primitive and is FIPS-approved
 * as of 186-5, but WebCrypto support for it is still uneven across runtimes.
 * Picking a default that silently fails to import on some deployment target
 * would be worse than picking the slightly older curve everything supports.
 */
export const DEFAULT_ALGORITHM: SignatureAlgorithm = 'ES256';

const supportCache = new Map<SignatureAlgorithm, Promise<boolean>>();

/**
 * Probe whether this runtime's WebCrypto can actually use an algorithm.
 *
 * Needed because `Ed25519` is absent from some WebCrypto implementations and the
 * failure surfaces as an opaque `NotSupportedError` deep inside a verify call.
 */
export function isAlgorithmSupported(algorithm: SignatureAlgorithm): Promise<boolean> {
  let cached = supportCache.get(algorithm);
  if (cached) return cached;

  cached = (async () => {
    const spec = ALGORITHMS[algorithm];
    if (!spec) return false;
    try {
      if (spec.kty === 'oct') {
        await subtle.importKey(
          'raw',
          buf(new Uint8Array(32)),
          spec.importParams as HmacImportParams,
          false,
          ['sign'],
        );
        return true;
      }
      const params =
        spec.kty === 'RSA'
          ? {
              ...(spec.importParams as RsaHashedImportParams),
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
            }
          : spec.importParams;
      await subtle.generateKey(params as EcKeyImportParams, true, ['sign', 'verify']);
      return true;
    } catch {
      return false;
    }
  })();

  supportCache.set(algorithm, cached);
  return cached;
}
