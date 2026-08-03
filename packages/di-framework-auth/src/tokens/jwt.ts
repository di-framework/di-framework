import { base64UrlDecodeString } from '../crypto/base64url.ts';
import { strictDecoder } from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';
import type { SignatureAlgorithm } from './algorithms.ts';
import { type JwsHeader, signJws, verifyJws } from './jws.ts';

/** JWT (RFC 7519) claim handling on top of the JWS layer. */

export interface JwtClaims extends Record<string, unknown> {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

export interface SignJwtOptions {
  algorithm: SignatureAlgorithm;
  key: CryptoKey;
  kid?: string;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  /** Lifetime in seconds. Sets `exp`. */
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  /** Include a random `jti`. Default true — needed for replay tracking. */
  jti?: string | boolean;
  now?: () => number;
}

export interface VerifyJwtOptions {
  /** **Required.** No default; see the note in `./jws.ts`. */
  algorithms: readonly SignatureAlgorithm[];
  key: CryptoKey | ((header: JwsHeader) => Promise<CryptoKey> | CryptoKey);
  /** Exact match against `iss`. */
  issuer?: string | readonly string[];
  /** `aud` must contain at least one of these. */
  audience?: string | readonly string[];
  subject?: string;
  /** Reject when `exp` is absent. Default true. */
  requireExpiry?: boolean;
  /**
   * Clock skew tolerance in seconds, default 30. Capped at 300 — a tolerance
   * measured in hours is not skew compensation, it is a token that outlives its
   * own expiry, so values above the cap throw rather than being clamped.
   */
  clockToleranceSeconds?: number;
  /** Reject a token issued more than this many seconds ago, regardless of `exp`. */
  maxTokenAgeSeconds?: number;
  now?: () => number;
}

const MAX_CLOCK_TOLERANCE_SECONDS = 300;

type ClaimRejection =
  | 'invalid_token'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'invalid_issuer'
  | 'invalid_audience';

function reject(message: string, code: ClaimRejection): never {
  throw new AuthError(message, { code });
}

export async function signJwt(claims: JwtClaims, options: SignJwtOptions): Promise<string> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const at = now();

  const payload: JwtClaims = {
    iat: at,
    ...(options.issuer !== undefined ? { iss: options.issuer } : {}),
    ...(options.audience !== undefined ? { aud: options.audience } : {}),
    ...(options.subject !== undefined ? { sub: options.subject } : {}),
    ...(options.expiresInSeconds !== undefined ? { exp: at + options.expiresInSeconds } : {}),
    ...(options.notBeforeSeconds !== undefined ? { nbf: at + options.notBeforeSeconds } : {}),
    ...claims,
  };

  if (options.jti !== false) {
    payload['jti'] = typeof options.jti === 'string' ? options.jti : crypto.randomUUID();
  }

  return signJws(JSON.stringify(payload), {
    algorithm: options.algorithm,
    key: options.key,
    typ: 'JWT',
    ...(options.kid !== undefined ? { kid: options.kid } : {}),
  });
}

export interface VerifiedJwt {
  header: JwsHeader;
  claims: JwtClaims;
}

export async function verifyJwt(token: string, options: VerifyJwtOptions): Promise<VerifiedJwt> {
  const tolerance = options.clockToleranceSeconds ?? 30;
  if (tolerance < 0 || tolerance > MAX_CLOCK_TOLERANCE_SECONDS) {
    throw new AuthError(
      `clockToleranceSeconds must be between 0 and ${MAX_CLOCK_TOLERANCE_SECONDS}; received ${tolerance}. ` +
        'A larger window does not compensate for skew, it extends every token past its expiry.',
      { status: 500, code: 'invalid_token' },
    );
  }

  const { header, payload } = await verifyJws(token, {
    algorithms: options.algorithms,
    key: options.key,
  });

  let claims: unknown;
  try {
    claims = JSON.parse(strictDecoder().decode(payload));
  } catch {
    reject('JWT payload is not valid UTF-8 JSON', 'invalid_token');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    reject('JWT payload is not a JSON object', 'invalid_token');
  }

  const jwt = claims as JwtClaims;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const at = now();

  if (options.issuer !== undefined) {
    const permitted = typeof options.issuer === 'string' ? [options.issuer] : options.issuer;
    if (typeof jwt.iss !== 'string' || !permitted.includes(jwt.iss)) {
      reject(
        `JWT iss '${String(jwt.iss)}' is not one of [${permitted.join(', ')}]`,
        'invalid_issuer',
      );
    }
  }

  if (options.audience !== undefined) {
    const permitted = typeof options.audience === 'string' ? [options.audience] : options.audience;
    const actual = jwt.aud === undefined ? [] : Array.isArray(jwt.aud) ? jwt.aud : [jwt.aud];
    if (!actual.some((value) => permitted.includes(value))) {
      reject(
        `JWT aud [${actual.join(', ')}] does not include any of [${permitted.join(', ')}]`,
        'invalid_audience',
      );
    }
  }

  if (options.subject !== undefined && jwt.sub !== options.subject) {
    reject(`JWT sub '${String(jwt.sub)}' does not match '${options.subject}'`, 'invalid_token');
  }

  if (jwt.exp !== undefined) {
    if (typeof jwt.exp !== 'number') reject('JWT exp is not a number', 'invalid_token');
    if (jwt.exp + tolerance <= at) reject(`JWT expired at ${jwt.exp}`, 'token_expired');
  } else if (options.requireExpiry !== false) {
    reject('JWT has no exp claim', 'invalid_token');
  }

  if (jwt.nbf !== undefined) {
    if (typeof jwt.nbf !== 'number') reject('JWT nbf is not a number', 'invalid_token');
    if (jwt.nbf - tolerance > at)
      reject(`JWT is not valid before ${jwt.nbf}`, 'token_not_yet_valid');
  }

  if (jwt.iat !== undefined && typeof jwt.iat !== 'number') {
    reject('JWT iat is not a number', 'invalid_token');
  }

  if (options.maxTokenAgeSeconds !== undefined) {
    if (typeof jwt.iat !== 'number')
      reject('JWT has no iat, so its age cannot be checked', 'invalid_token');
    if (jwt.iat + options.maxTokenAgeSeconds + tolerance <= at) {
      reject(`JWT is older than ${options.maxTokenAgeSeconds}s`, 'token_expired');
    }
  }

  return { header, claims: jwt };
}

/** Read the claims without verifying. For diagnostics and `iss` discovery only. */
export function decodeJwtUnsafe(token: string): JwtClaims {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new AuthError('Malformed JWT', { code: 'invalid_token' });
  }
  try {
    // The same strict base64url decoder the verifying path uses. `atob` returns
    // one character per *byte*, so any non-ASCII claim — a display name, an
    // issuer with an IDN — comes back as mojibake rather than the string that
    // was signed. It is also lenient about `+`/`/` and padding, which would let
    // a token decode here that `verifyJws` would reject, so what you inspect
    // would not be what gets verified.
    const json = base64UrlDecodeString(segments[1]!);
    return JSON.parse(json) as JwtClaims;
  } catch (cause) {
    throw new AuthError('Malformed JWT payload', { code: 'invalid_token', cause });
  }
}
