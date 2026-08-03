import { base64UrlEncode } from '../crypto/base64url.ts';
import { buf, subtle } from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';
import { isAlgorithmSupported } from '../tokens/algorithms.ts';
import { derToP1363 } from '../tokens/jws.ts';
import { asCborMap, type CborValue, decodeCbor } from './cbor.ts';

/**
 * COSE key handling (RFC 8152) for WebAuthn credential public keys.
 *
 * Only the three algorithms authenticators actually produce are supported.
 * Anything else is rejected rather than best-effort parsed — an unrecognised
 * key type that "mostly works" is a credential that can be registered and then
 * never used.
 */

/** COSE algorithm identifiers, from the IANA COSE Algorithms registry. */
export const COSE_ALG = {
  ES256: -7,
  EdDSA: -8,
  ES384: -35,
  ES512: -36,
  RS256: -257,
} as const;

export type CoseAlgorithm = (typeof COSE_ALG)[keyof typeof COSE_ALG];

/**
 * The algorithms offered during registration, in preference order.
 *
 * **EdDSA (-8) is deliberately absent.** Algorithm selection at registration is
 * a one-way door for that credential: if the authenticator picks EdDSA and this
 * runtime's WebCrypto cannot verify Ed25519, the user has successfully
 * registered a passkey they can never sign in with, and the only recovery is
 * deleting it. Opt in through `WebAuthnConfig.pubKeyCredParams` once you have
 * confirmed your deployment target supports it — `webAuthnService` verifies the
 * runtime at construction when you do.
 */
export const DEFAULT_PUBKEY_CRED_PARAMS: readonly CoseAlgorithm[] = [
  COSE_ALG.ES256,
  COSE_ALG.RS256,
];

/** COSE key common parameters (RFC 8152 §7.1). */
const COSE_KTY = 1;
const COSE_ALG_LABEL = 3;
/** EC2 / OKP parameters (RFC 8152 §13.1). */
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
/** RSA parameters (RFC 8230 §4). */
const COSE_N = -1;
const COSE_E = -2;

const KTY_OKP = 1;
const KTY_EC2 = 2;
const KTY_RSA = 3;

const CRV_P256 = 1;
const CRV_ED25519 = 6;

export interface CoseKey {
  kty: number;
  alg: number;
  raw: Uint8Array;
  crv?: number;
  x?: Uint8Array;
  y?: Uint8Array;
  n?: Uint8Array;
  e?: Uint8Array;
}

function fail(message: string): never {
  throw new AuthError(message, { code: 'unsupported_algorithm', status: 400 });
}

function bytesAt(map: Map<CborValue, CborValue>, label: number, what: string): Uint8Array {
  const value = map.get(label);
  if (!(value instanceof Uint8Array)) fail(`COSE key ${what} is missing or not a byte string`);
  return value;
}

/** Parse a COSE_Key. `raw` is retained so the credential can be stored verbatim. */
export function parseCoseKey(bytes: Uint8Array): CoseKey {
  const map = asCborMap(decodeCbor(bytes), 'COSE key');

  const kty = map.get(COSE_KTY);
  const alg = map.get(COSE_ALG_LABEL);
  if (typeof kty !== 'number') fail('COSE key has no kty');
  if (typeof alg !== 'number') fail('COSE key has no alg');

  const key: CoseKey = { kty, alg, raw: bytes };

  switch (kty) {
    case KTY_EC2: {
      const crv = map.get(COSE_CRV);
      if (typeof crv !== 'number') fail('COSE EC2 key has no crv');
      key.crv = crv;
      key.x = bytesAt(map, COSE_X, 'x');
      key.y = bytesAt(map, COSE_Y, 'y');
      break;
    }
    case KTY_OKP: {
      const crv = map.get(COSE_CRV);
      if (typeof crv !== 'number') fail('COSE OKP key has no crv');
      key.crv = crv;
      key.x = bytesAt(map, COSE_X, 'x');
      break;
    }
    case KTY_RSA: {
      key.n = bytesAt(map, COSE_N, 'n');
      key.e = bytesAt(map, COSE_E, 'e');
      break;
    }
    default:
      fail(`Unsupported COSE key type ${kty}`);
  }

  return key;
}

/** Import a COSE key as a WebCrypto verification key. */
export async function importCoseKey(key: CoseKey): Promise<CryptoKey> {
  switch (key.alg) {
    case COSE_ALG.ES256: {
      if (key.kty !== KTY_EC2 || key.crv !== CRV_P256) {
        fail('COSE alg -7 (ES256) requires an EC2 key on P-256');
      }
      // P-256 coordinates are exactly 32 bytes. A short or long coordinate would
      // be rejected by importKey with an opaque DOMException, so check here and
      // report something a developer can act on.
      if (key.x?.length !== 32 || key.y?.length !== 32) {
        fail(`COSE P-256 coordinates must be 32 bytes (x=${key.x?.length}, y=${key.y?.length})`);
      }
      return subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          x: base64UrlEncode(key.x),
          y: base64UrlEncode(key.y),
          ext: true,
        },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    }

    case COSE_ALG.RS256: {
      if (key.kty !== KTY_RSA) fail('COSE alg -257 (RS256) requires an RSA key');
      const modulus = key.n!;
      // Strip DER-style sign padding before measuring the modulus.
      const significant = modulus[0] === 0x00 ? modulus.subarray(1) : modulus;
      if (significant.length < 256) {
        fail(`RSA modulus is ${significant.length * 8} bits; a minimum of 2048 is required`);
      }
      return subtle.importKey(
        'jwk',
        {
          kty: 'RSA',
          n: base64UrlEncode(significant),
          e: base64UrlEncode(key.e!),
          ext: true,
        },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
    }

    case COSE_ALG.EdDSA: {
      if (key.kty !== KTY_OKP || key.crv !== CRV_ED25519) {
        fail('COSE alg -8 (EdDSA) requires an OKP key on Ed25519');
      }
      if (!(await isAlgorithmSupported('EdDSA'))) {
        fail(
          "This runtime's WebCrypto cannot verify Ed25519. Restrict WebAuthnConfig." +
            'pubKeyCredParams to [-7, -257], or deploy on a runtime with Ed25519 support.',
        );
      }
      if (key.x?.length !== 32) fail(`Ed25519 public keys are 32 bytes; received ${key.x?.length}`);
      return subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: base64UrlEncode(key.x), ext: true },
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    }

    default:
      return fail(`Unsupported COSE algorithm ${key.alg}`);
  }
}

/**
 * Verify a WebAuthn assertion or attestation signature.
 *
 * ECDSA signatures arrive DER-encoded (authenticators follow X9.62), while
 * WebCrypto wants the fixed-width P1363 form. That conversion is isolated in
 * `derToP1363`, which is where the leading-zero and sign-extension cases are
 * handled — get it wrong and roughly half of all signatures fail, which is a
 * uniquely confusing bug to debug in production.
 */
export async function verifyCoseSignature(
  key: CoseKey,
  signature: Uint8Array,
  signedData: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importCoseKey(key);

  switch (key.alg) {
    case COSE_ALG.ES256: {
      const raw = signature.length === 64 ? signature : derToP1363(signature, 64);
      return subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        buf(raw),
        buf(signedData),
      );
    }
    case COSE_ALG.RS256:
      return subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, buf(signature), buf(signedData));
    case COSE_ALG.EdDSA:
      return subtle.verify('Ed25519', cryptoKey, buf(signature), buf(signedData));
    default:
      return fail(`Unsupported COSE algorithm ${key.alg}`);
  }
}

export function isSupportedCoseAlgorithm(alg: number): alg is CoseAlgorithm {
  return alg === COSE_ALG.ES256 || alg === COSE_ALG.RS256 || alg === COSE_ALG.EdDSA;
}
