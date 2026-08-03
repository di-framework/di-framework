import { base64UrlEncode } from '../crypto/base64url.ts';
import { sha256 } from '../crypto/hash.ts';
import {
  buf,
  type EcKeyImportParams,
  type HmacImportParams,
  type KeyUsage,
  type RsaHashedImportParams,
  subtle,
} from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';
import {
  algorithmSpec,
  DEFAULT_ALGORITHM,
  isAlgorithmSupported,
  type SignatureAlgorithm,
} from './algorithms.ts';

/** JSON Web Key handling (RFC 7517) and thumbprints (RFC 7638). */

export interface Jwk extends Record<string, unknown> {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
}

export interface JwkSet {
  keys: Jwk[];
}

/**
 * RFC 7638 §3 thumbprint: SHA-256 over the canonical JSON of the *required*
 * members only, in lexicographic order. Used as the default `kid`, so a key's
 * identifier is derived from the key rather than assigned — two systems holding
 * the same key agree on its name without coordinating.
 */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const required: Record<string, string[]> = {
    EC: ['crv', 'kty', 'x', 'y'],
    RSA: ['e', 'kty', 'n'],
    oct: ['k', 'kty'],
    OKP: ['crv', 'kty', 'x'],
  };

  const members = required[jwk.kty];
  if (!members)
    throw new AuthError(`Cannot compute a thumbprint for kty '${jwk.kty}'`, { status: 500 });

  const canonical: Record<string, unknown> = {};
  for (const member of members) {
    const value = jwk[member];
    if (typeof value !== 'string') {
      throw new AuthError(`JWK is missing required member '${member}'`, { status: 500 });
    }
    canonical[member] = value;
  }

  return base64UrlEncode(await sha256(JSON.stringify(canonical)));
}

/** Strip private members, leaving a JWK safe to publish in a JWKS. */
export function toPublicJwk(jwk: Jwk): Jwk {
  const { d, p, q, dp, dq, qi, oth, k, ...pub } = jwk as Record<string, unknown>;
  return pub as Jwk;
}

export interface GeneratedKeyPair {
  algorithm: SignatureAlgorithm;
  kid: string;
  privateJwk: Jwk;
  publicJwk: Jwk;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Generate a signing key pair and derive its `kid` from the public thumbprint. */
export async function generateKeyPair(
  algorithm: SignatureAlgorithm = DEFAULT_ALGORITHM,
): Promise<GeneratedKeyPair> {
  const spec = algorithmSpec(algorithm);
  if (spec.kty === 'oct') {
    throw new AuthError(
      `generateKeyPair does not support the symmetric algorithm '${algorithm}'; use importHmacKey`,
      { status: 500 },
    );
  }
  if (!(await isAlgorithmSupported(algorithm))) {
    throw new AuthError(
      `This runtime's WebCrypto cannot generate '${algorithm}' keys. ES256 is supported everywhere; ` +
        'EdDSA support is still uneven.',
      { code: 'unsupported_algorithm', status: 500 },
    );
  }

  const params =
    spec.kty === 'RSA'
      ? {
          ...(spec.importParams as RsaHashedImportParams),
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
        }
      : spec.importParams;

  const pair = (await subtle.generateKey(params as EcKeyImportParams, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const privateJwk = (await subtle.exportKey('jwk', pair.privateKey)) as Jwk;
  const publicJwk = (await subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  const kid = await jwkThumbprint(publicJwk);

  return {
    algorithm,
    kid,
    privateJwk: { ...privateJwk, kid, alg: algorithm, use: 'sig' },
    publicJwk: { ...publicJwk, kid, alg: algorithm, use: 'sig' },
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

/** Import a JWK as a WebCrypto key bound to exactly one algorithm. */
export async function importJwk(
  jwk: Jwk,
  algorithm: SignatureAlgorithm,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  const spec = algorithmSpec(algorithm);
  if (jwk.kty !== spec.kty) {
    throw new AuthError(
      `JWK kty '${jwk.kty}' does not match algorithm '${algorithm}' (expected '${spec.kty}')`,
      { code: 'invalid_algorithm' },
    );
  }
  if (spec.curve && typeof jwk['crv'] === 'string' && jwk['crv'] !== spec.curve) {
    throw new AuthError(
      `JWK curve '${jwk['crv']}' does not match algorithm '${algorithm}' (expected '${spec.curve}')`,
      { code: 'invalid_algorithm' },
    );
  }

  // Never trust `alg` from a fetched JWKS to select the import parameters — that
  // would hand key-algorithm selection to whoever served the document.
  return subtle.importKey('jwk', jwk as JsonWebKey, spec.importParams as EcKeyImportParams, false, [
    usage,
  ]);
}

/** Import a shared secret for the HS* family. */
export async function importHmacKey(
  secret: Uint8Array | string,
  algorithm: SignatureAlgorithm = 'HS256',
  usages: KeyUsage[] = ['sign', 'verify'],
): Promise<CryptoKey> {
  const spec = algorithmSpec(algorithm);
  if (spec.kty !== 'oct') {
    throw new AuthError(`'${algorithm}' is not a symmetric algorithm`, { status: 500 });
  }
  const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  // RFC 7518 §3.2: an HMAC key must be at least as long as the digest output.
  const minimum = Number.parseInt(algorithm.slice(2), 10) / 8;
  if (bytes.length < minimum) {
    throw new AuthError(
      `${algorithm} requires a key of at least ${minimum} bytes; received ${bytes.length}`,
      { status: 500 },
    );
  }
  return subtle.importKey('raw', buf(bytes), spec.importParams as HmacImportParams, false, usages);
}
