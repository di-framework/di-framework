import { base64UrlEncode } from '../crypto/base64url.ts';
import { timingSafeEqualString } from '../crypto/compare.ts';
import { digest } from '../crypto/hash.ts';
import { AuthError } from '../errors.ts';
import type { SignatureAlgorithm } from '../tokens/algorithms.ts';
import type { RemoteJwks } from '../tokens/jwks.ts';
import { type JwtClaims, verifyJwt } from '../tokens/jwt.ts';

/** ID token validation (OpenID Connect Core 1.0 §3.1.3.7). */

export interface IdTokenValidationOptions {
  issuer: string;
  clientId: string;
  /** The nonce sent in the authorization request, or `null` for non-OIDC providers. */
  nonce: string | null;
  algorithms: readonly SignatureAlgorithm[];
  jwks: RemoteJwks;
  /** Enables `at_hash` verification. */
  accessToken?: string;
  /** Enables `c_hash` verification. */
  code?: string;
  /** When `max_age` was requested, forces an `auth_time` check. */
  maxAgeSeconds?: number;
  clockToleranceSeconds?: number;
  now?: () => number;
}

function reject(
  message: string,
  code: 'invalid_token' | 'nonce_mismatch' | 'invalid_issuer',
): never {
  throw new AuthError(message, { code });
}

/**
 * OIDC Core §3.1.3.6: the hash is the leftmost half of the digest implied by the
 * ID token's signing algorithm, base64url encoded.
 */
export async function computeTokenHash(
  value: string,
  alg: SignatureAlgorithm,
): Promise<string | null> {
  const digestAlgorithm = alg.endsWith('512')
    ? ('SHA-512' as const)
    : alg.endsWith('384')
      ? ('SHA-384' as const)
      : alg.endsWith('256')
        ? ('SHA-256' as const)
        : null;

  // EdDSA's `at_hash` digest is not unambiguously pinned by JWA for this use —
  // it depends on the curve (SHA-512 for Ed25519, SHAKE256 for Ed448), and
  // guessing wrong would reject valid tokens. Returning null skips the check
  // rather than failing; no major provider signs ID tokens with EdDSA today.
  if (!digestAlgorithm) return null;

  const hash = await digest(digestAlgorithm, new TextEncoder().encode(value));
  return base64UrlEncode(hash.subarray(0, hash.length / 2));
}

export async function validateIdToken(
  idToken: string,
  options: IdTokenValidationOptions,
): Promise<JwtClaims> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tolerance = options.clockToleranceSeconds ?? 30;

  const { header, claims } = await verifyJwt(idToken, {
    algorithms: options.algorithms,
    key: (jwsHeader) => options.jwks.getKey(jwsHeader),
    issuer: options.issuer,
    audience: options.clientId,
    clockToleranceSeconds: tolerance,
    now,
  });

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    reject('ID token has no sub claim', 'invalid_token');
  }

  // OIDC Core §3.1.3.7 step 4-5: when `aud` names more than one audience, or
  // when `azp` is present at all, `azp` must be this client. Without this a
  // token issued for a different client at the same provider is accepted.
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  const azp = claims['azp'];
  if (audiences.length > 1 || azp !== undefined) {
    if (azp !== options.clientId) {
      reject(
        `ID token azp '${String(azp)}' does not match client '${options.clientId}'`,
        'invalid_token',
      );
    }
  }

  // The nonce is the ID token's own replay defence, and it is separate from
  // `state`, which protects the callback. Systems that check only `state` have
  // a real gap: `state` binds the redirect to this browser, but nothing stops a
  // previously captured ID token from being presented in a fresh flow.
  if (options.nonce !== null) {
    if (typeof claims['nonce'] !== 'string')
      reject('ID token has no nonce claim', 'nonce_mismatch');
    if (!(await timingSafeEqualString(claims['nonce'], options.nonce))) {
      reject('ID token nonce does not match the authorization request', 'nonce_mismatch');
    }
  }

  if (options.maxAgeSeconds !== undefined) {
    const authTime = claims['auth_time'];
    if (typeof authTime !== 'number') {
      reject('ID token has no auth_time although max_age was requested', 'invalid_token');
    }
    if (authTime + options.maxAgeSeconds + tolerance < now()) {
      reject(
        `ID token auth_time ${authTime} is older than max_age ${options.maxAgeSeconds}`,
        'invalid_token',
      );
    }
  }

  if (options.accessToken && typeof claims['at_hash'] === 'string') {
    const expected = await computeTokenHash(options.accessToken, header.alg);
    if (expected !== null && !(await timingSafeEqualString(claims['at_hash'], expected)))
      reject('ID token at_hash does not match the access token', 'invalid_token');
  }

  if (options.code && typeof claims['c_hash'] === 'string') {
    const expected = await computeTokenHash(options.code, header.alg);
    if (expected !== null && !(await timingSafeEqualString(claims['c_hash'], expected)))
      reject('ID token c_hash does not match the authorization code', 'invalid_token');
  }

  return claims;
}
