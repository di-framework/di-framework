import { base64UrlDecode, base64UrlEncode } from './crypto/base64url.ts';
import { timingSafeEqualString } from './crypto/compare.ts';
import { concatBytes } from './crypto/hash.ts';
import { deriveHmacKey, KDF_LABELS } from './crypto/kdf.ts';
import { randomToken } from './crypto/random.ts';
import { buf, subtle } from './crypto/webcrypto.ts';

/**
 * CSRF defence for cookie-authenticated requests.
 *
 * Two independent checks, both required to pass:
 *
 * 1. **Signed double-submit.** The token is `<nonce>.<HMAC(nonce ‖ sessionId)>`,
 *    sent in a readable cookie and echoed in a header. Binding the session id
 *    into the MAC is what distinguishes this from the naive double-submit
 *    pattern: an attacker who can set cookies on a sibling subdomain can plant
 *    a matching cookie/header pair, but cannot produce one that validates
 *    against the *victim's* session.
 *
 * 2. **Origin / `Sec-Fetch-Site`.** A cheap, independent signal that catches
 *    cross-site requests before any token work happens.
 *
 * `SameSite=Lax` is a useful third layer but is not sufficient on its own: it
 * does not apply to `SameSite=None` deployments, and browsers that predate it
 * are still in the wild.
 *
 * This applies only when the principal was established from a **cookie**.
 * Bearer-token and API-key requests carry no ambient credential, so they are not
 * CSRF-able and must not be forced to present a token.
 */

const HEADER_NAME = 'x-csrf-token';
/** Methods that cannot change state, per RFC 9110 §9.2.1. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export interface CsrfOptions {
  /** Master secret; the CSRF HMAC key is HKDF-derived from it. */
  secret: Uint8Array | string;
  /** Request header carrying the echoed token. Default `x-csrf-token`. */
  headerName?: string;
  /**
   * Origins permitted to make state-changing requests. When set, the `Origin`
   * header must be one of them — exact string match after normalisation.
   */
  allowedOrigins?: readonly string[];
  /**
   * Reject when neither `Origin` nor `Sec-Fetch-Site` is present. Defaults to
   * `false`, because non-browser clients legitimately send neither; the token
   * check still applies to them.
   */
  requireOriginHeader?: boolean;
}

export interface CsrfGuard {
  /** Mint a token bound to `sessionId`. Safe to expose to client script. */
  issue(sessionId: string): Promise<string>;
  /** Validate the token carried by `request` against `sessionId`. */
  verify(request: Request, sessionId: string, submitted?: string): Promise<CsrfVerdict>;
  readonly headerName: string;
}

export type CsrfVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_token' | 'invalid_token' | 'cross_origin' };

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Cross-site check.
 *
 * `Sec-Fetch-Site` is authoritative where present — it is set by the browser and
 * cannot be forged by page script. `Origin` is the fallback for browsers that
 * do not send fetch metadata.
 */
export function checkRequestOrigin(
  request: Request,
  options: Pick<CsrfOptions, 'allowedOrigins' | 'requireOriginHeader'> = {},
): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
    // `same-site` still permits a sibling subdomain, which is exactly the
    // attacker position the session-bound token defends against — so reject
    // here and let the token be the only thing that could save it.
    return false;
  }

  const origin = request.headers.get('origin');
  if (!origin) return options.requireOriginHeader !== true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (options.allowedOrigins?.length) {
    return options.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
  }
  return normalized === normalizeOrigin(request.url);
}

export function csrfGuard(options: CsrfOptions): CsrfGuard {
  const headerName = (options.headerName ?? HEADER_NAME).toLowerCase();
  let keyPromise: Promise<CryptoKey> | undefined;

  const key = (): Promise<CryptoKey> => {
    keyPromise ??= deriveHmacKey(options.secret, KDF_LABELS.csrf);
    return keyPromise;
  };

  const sign = async (nonce: string, sessionId: string): Promise<string> => {
    const encoder = new TextEncoder();
    const message = concatBytes(
      encoder.encode(nonce),
      new Uint8Array([0]),
      encoder.encode(sessionId),
    );
    const mac = await subtle.sign('HMAC', await key(), buf(message));
    return base64UrlEncode(new Uint8Array(mac));
  };

  return {
    headerName,

    async issue(sessionId) {
      const nonce = randomToken(16);
      return `${nonce}.${await sign(nonce, sessionId)}`;
    },

    async verify(request, sessionId, submitted) {
      if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

      if (!checkRequestOrigin(request, options)) return { ok: false, reason: 'cross_origin' };

      const token = submitted ?? request.headers.get(headerName) ?? undefined;
      if (!token) return { ok: false, reason: 'missing_token' };

      const separator = token.indexOf('.');
      if (separator <= 0) return { ok: false, reason: 'invalid_token' };

      const nonce = token.slice(0, separator);
      const mac = token.slice(separator + 1);
      try {
        // Reject a malformed MAC before spending an HMAC on it.
        base64UrlDecode(mac);
      } catch {
        return { ok: false, reason: 'invalid_token' };
      }

      const expected = await sign(nonce, sessionId);
      return (await timingSafeEqualString(mac, expected))
        ? { ok: true }
        : { ok: false, reason: 'invalid_token' };
    },
  };
}

/** True when the request method can change state and therefore needs a CSRF check. */
export function requiresCsrfCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
