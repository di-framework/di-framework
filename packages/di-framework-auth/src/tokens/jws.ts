import { base64UrlDecode, base64UrlEncode, base64UrlEncodeString } from '../crypto/base64url.ts';
import { type AlgorithmIdentifier, buf, strictDecoder, subtle } from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';
import { algorithmSpec, isSignatureAlgorithm, type SignatureAlgorithm } from './algorithms.ts';

/**
 * Compact JWS (RFC 7515) over the Web Crypto API.
 *
 * The design goal here is that the dangerous configurations are *unrepresentable*
 * rather than merely discouraged:
 *
 * - `algorithms` is a **required** field on {@link VerifyJwsOptions}. There is no
 *   default, so "verify with whatever the token says" cannot be written by
 *   accident. This is the single most important line in the file.
 * - The algorithm is taken from the caller's allowlist and the resolved key,
 *   never from the token header alone. That is what closes the RS256→HS256
 *   confusion attack, where an attacker re-signs a token with the RSA *public*
 *   key as an HMAC secret and a naive verifier accepts it.
 * - `alg: none` has no representation in {@link SignatureAlgorithm}, so it fails
 *   the allowlist check before any key is touched.
 * - A header-embedded `jwk`, a non-empty `crit`, and `b64: false` are all
 *   rejected: each is a way for the token to instruct the verifier, and a token
 *   is attacker-controlled input.
 */

export interface JwsHeader {
  alg: SignatureAlgorithm;
  kid?: string;
  typ?: string;
  cty?: string;
  [claim: string]: unknown;
}

export interface SignJwsOptions {
  algorithm: SignatureAlgorithm;
  key: CryptoKey;
  kid?: string;
  typ?: string;
  /** Extra protected-header members. Cannot override `alg`. */
  header?: Record<string, unknown>;
}

export interface VerifyJwsOptions {
  /**
   * Permitted algorithms. **Required** — omitting it is not possible, which is
   * the point. Set it to exactly the algorithms your keys use.
   */
  algorithms: readonly SignatureAlgorithm[];
  /** Resolve the verification key. Receives the parsed header for `kid` lookup. */
  key: CryptoKey | ((header: JwsHeader) => Promise<CryptoKey> | CryptoKey);
}

export interface VerifiedJws {
  header: JwsHeader;
  payload: Uint8Array;
  /** The `<header>.<payload>` bytes that were signed. */
  signingInput: string;
}

const encoder = new TextEncoder();

function invalid(
  message: string,
  code: 'invalid_token' | 'invalid_signature' | 'invalid_algorithm' = 'invalid_token',
): never {
  throw new AuthError(message, { code });
}

/* -------------------------------------------------------------------------- */
/* ECDSA signature encoding                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Convert a DER-encoded ECDSA signature to the fixed-width IEEE P1363 form
 * WebCrypto expects.
 *
 * This conversion is the most common source of bugs in from-scratch JOSE and
 * WebAuthn implementations. DER integers are signed and minimally encoded, so an
 * `r` whose high bit is set gains a leading `0x00` byte, and an `r` with leading
 * zero bytes loses them — meaning the DER length varies from signature to
 * signature while P1363 is always exactly `2 × curveBytes`. Getting this wrong
 * produces an implementation that works for roughly half of all signatures.
 */
export function derToP1363(der: Uint8Array, signatureBytes: number): Uint8Array {
  const half = signatureBytes / 2;
  let offset = 0;

  if (der[offset++] !== 0x30) invalid('Malformed ECDSA signature: expected DER SEQUENCE');

  // Length may be short-form or one-byte long-form; ECDSA signatures never exceed 127 bytes
  // of content for P-521, so a two-byte long form would itself be malformed.
  let sequenceLength = der[offset++]!;
  if (sequenceLength & 0x80) {
    const lengthBytes = sequenceLength & 0x7f;
    if (lengthBytes !== 1) invalid('Malformed ECDSA signature: unsupported DER length');
    sequenceLength = der[offset++]!;
  }
  if (offset + sequenceLength !== der.length) {
    invalid('Malformed ECDSA signature: DER length mismatch');
  }

  const readInteger = (): Uint8Array => {
    if (der[offset++] !== 0x02) invalid('Malformed ECDSA signature: expected DER INTEGER');
    const length = der[offset++]!;
    if (length === 0 || offset + length > der.length) {
      invalid('Malformed ECDSA signature: bad INTEGER length');
    }
    let value = der.subarray(offset, offset + length);
    offset += length;
    // Strip the sign-extension byte DER adds when the high bit is set.
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    if (value.length > half) invalid('Malformed ECDSA signature: INTEGER too large for curve');
    return value;
  };

  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) invalid('Malformed ECDSA signature: trailing DER bytes');

  const out = new Uint8Array(signatureBytes);
  out.set(r, half - r.length);
  out.set(s, signatureBytes - s.length);
  return out;
}

/** Convert a fixed-width P1363 ECDSA signature to DER. Inverse of {@link derToP1363}. */
export function p1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const encodeInteger = (value: Uint8Array): number[] => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start++;
    const trimmed = [...value.subarray(start)];
    // Re-add the sign byte when the high bit is set, or DER reads it as negative.
    if ((trimmed[0]! & 0x80) !== 0) trimmed.unshift(0x00);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...encodeInteger(raw.subarray(0, half)), ...encodeInteger(raw.subarray(half))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/* -------------------------------------------------------------------------- */
/* Sign                                                                       */
/* -------------------------------------------------------------------------- */

export async function signJws(
  payload: Uint8Array | string,
  options: SignJwsOptions,
): Promise<string> {
  const spec = algorithmSpec(options.algorithm);

  const header: JwsHeader = {
    ...options.header,
    // Last, so a caller cannot smuggle a different `alg` through `header`.
    alg: options.algorithm,
    ...(options.kid !== undefined ? { kid: options.kid } : {}),
    ...(options.typ !== undefined ? { typ: options.typ } : {}),
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(
    typeof payload === 'string' ? encoder.encode(payload) : payload,
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = new Uint8Array(
    await subtle.sign(
      spec.signParams as AlgorithmIdentifier,
      options.key,
      buf(encoder.encode(signingInput)),
    ),
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse the protected header without verifying. For `kid`-based key lookup only. */
export function decodeJwsHeader(token: string): JwsHeader {
  const firstDot = token.indexOf('.');
  if (firstDot <= 0) invalid('Malformed JWS: missing header segment');

  let header: unknown;
  try {
    header = JSON.parse(strictDecoder().decode(base64UrlDecode(token.slice(0, firstDot))));
  } catch {
    invalid('Malformed JWS: header is not valid base64url JSON');
  }

  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    invalid('Malformed JWS: header is not a JSON object');
  }

  const candidate = header as Record<string, unknown>;

  // A token that carries its own verification key is a token that verifies
  // itself. RFC 7515 §4.1.3 permits `jwk` in the header; accepting one here
  // would let any attacker mint valid tokens.
  if ('jwk' in candidate) invalid('JWS header contains an embedded jwk, which is never accepted');
  if ('jku' in candidate) invalid('JWS header contains jku, which is never accepted');
  if ('x5u' in candidate) invalid('JWS header contains x5u, which is never accepted');

  // RFC 7515 §4.1.11: a verifier that does not understand every `crit` entry
  // MUST reject. We understand none of them.
  const crit = candidate['crit'];
  if (crit !== undefined) {
    if (!Array.isArray(crit) || crit.length > 0)
      invalid('JWS header declares unsupported critical parameters');
  }

  // RFC 7797 unencoded payloads change what the signature covers.
  if (candidate['b64'] === false) invalid('JWS with b64=false is not supported');

  if (!isSignatureAlgorithm(candidate['alg'])) {
    invalid(`Unsupported or missing JWS alg '${String(candidate['alg'])}'`, 'invalid_algorithm');
  }

  return candidate as JwsHeader;
}

export async function verifyJws(token: string, options: VerifyJwsOptions): Promise<VerifiedJws> {
  if (options.algorithms.length === 0) {
    throw new AuthError('verifyJws requires a non-empty algorithm allowlist', {
      code: 'unsupported_algorithm',
      status: 500,
    });
  }

  const segments = token.split('.');
  if (segments.length !== 3) {
    invalid(`Malformed JWS: expected 3 segments, received ${segments.length}`);
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];

  const header = decodeJwsHeader(token);

  // The allowlist decides, not the token. `alg: none` never reaches this check
  // because it is not a member of SignatureAlgorithm.
  if (!options.algorithms.includes(header.alg)) {
    invalid(
      `JWS alg '${header.alg}' is not in the permitted set [${options.algorithms.join(', ')}]`,
      'invalid_algorithm',
    );
  }

  const spec = algorithmSpec(header.alg);
  const key = typeof options.key === 'function' ? await options.key(header) : options.key;

  // Belt and braces against alg confusion: even if a caller's key resolver
  // returns the wrong key type, WebCrypto's own algorithm binding on the
  // CryptoKey must agree with the header.
  const keyAlgorithm = (key.algorithm as { name?: string }).name;
  const expectedName =
    typeof spec.signParams === 'string'
      ? spec.signParams
      : (spec.signParams as { name: string }).name;
  if (keyAlgorithm !== expectedName) {
    invalid(
      `Key algorithm '${String(keyAlgorithm)}' does not match JWS alg '${header.alg}'`,
      'invalid_algorithm',
    );
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(encodedSignature);
  } catch {
    invalid('Malformed JWS: signature is not valid base64url', 'invalid_signature');
  }

  if (spec.ecdsaSignatureBytes !== undefined && signature.length !== spec.ecdsaSignatureBytes) {
    // Some producers emit DER instead of the P1363 form JOSE mandates. Accept it
    // rather than failing opaquely, but only after a strict re-encode, so a
    // malleable DER blob cannot smuggle through extra bytes.
    signature = derToP1363(signature, spec.ecdsaSignatureBytes);
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const valid = await subtle.verify(
    spec.signParams as AlgorithmIdentifier,
    key,
    buf(signature),
    buf(encoder.encode(signingInput)),
  );
  if (!valid) invalid('JWS signature verification failed', 'invalid_signature');

  let payload: Uint8Array;
  try {
    payload = base64UrlDecode(encodedPayload);
  } catch {
    invalid('Malformed JWS: payload is not valid base64url');
  }

  return { header, payload, signingInput };
}
