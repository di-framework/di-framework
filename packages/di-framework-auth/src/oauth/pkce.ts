import { base64UrlEncode } from '../crypto/base64url.ts';
import { sha256 } from '../crypto/hash.ts';
import { randomBytes } from '../crypto/random.ts';

/**
 * Proof Key for Code Exchange (RFC 7636).
 *
 * Only `S256` exists here. RFC 7636 §7.2 and RFC 9700 §2.1.1 are explicit that
 * `plain` provides no protection against an attacker who can observe the
 * authorization request — there is deliberately no code path that emits or
 * accepts it, and no option to enable one.
 */

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * 32 random bytes base64url-encode to exactly 43 characters, all of which are in
 * the unreserved set — the shortest verifier the RFC permits, at full entropy.
 */
const DEFAULT_VERIFIER_BYTES = 32;

export function generateCodeVerifier(bytes: number = DEFAULT_VERIFIER_BYTES): string {
  if (bytes < 32 || bytes > 96) {
    throw new RangeError(
      `PKCE verifier entropy must be 32–96 bytes to land within RFC 7636's 43–128 character range; received ${bytes}`,
    );
  }
  return base64UrlEncode(randomBytes(bytes));
}

/** RFC 7636 §4.2: `base64url(SHA-256(ASCII(code_verifier)))`. */
export async function computeS256Challenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}

export async function generatePkce(bytes: number = DEFAULT_VERIFIER_BYTES): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier(bytes);
  return {
    codeVerifier,
    codeChallenge: await computeS256Challenge(codeVerifier),
    codeChallengeMethod: 'S256',
  };
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}
