/**
 * The authenticated subject.
 *
 * This is deliberately *not* an authorization model. There are no roles and no
 * permissions, and there never will be — `@di-framework/auth` answers "who is
 * this request from, and how did they prove it", and your domain code answers
 * "what are they allowed to do". `scope`, `amr`, `acr`, and `claims` are carried
 * as data so that domain code has everything it needs to decide.
 */

/** How the principal proved their identity on this request. */
export type AuthMethod =
  | 'password'
  | 'session'
  | 'bearer'
  | 'oauth'
  | 'webauthn'
  | 'api-key'
  | (string & {});

export interface Principal {
  /** Stable subject identifier. Unique within `issuer`. */
  readonly sub: string;
  /** The credential presented on *this* request. */
  readonly method: AuthMethod;
  /**
   * Authentication Methods References (RFC 8176) — e.g. `['pwd']`,
   * `['hwk', 'user', 'mfa']`. Lets domain code implement step-up without this
   * package growing a policy engine.
   */
  readonly amr?: readonly string[];
  /** Authentication Context Class Reference (OIDC Core §2). */
  readonly acr?: string;
  /**
   * When the *original* authentication happened, in seconds since the epoch.
   * Distinct from the token's `iat`: a refreshed session keeps its `authTime`,
   * which is what makes `max_age` and step-up checks meaningful.
   */
  readonly authTime: number;
  /** Issuer of the credential — an OIDC issuer URL, or undefined for local credentials. */
  readonly issuer?: string;
  /**
   * OAuth 2.0 scopes granted to the token. Surfaced as *data*; this package does
   * not interpret scopes outside `src/oauth/`, where parsing them is intrinsic
   * to reading a token response.
   */
  readonly scope?: readonly string[];
  /** Server-side session this principal came from, when applicable. */
  readonly sessionId?: string;
  /** When the credential expires, in seconds since the epoch. */
  readonly expiresAt?: number;
  /** Raw claims from the underlying credential, for domain code to inspect. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface CreatePrincipalInput extends Omit<Principal, 'authTime'> {
  authTime?: number;
}

/** Build a `Principal`, defaulting `authTime` to now. */
export function createPrincipal(input: CreatePrincipalInput): Principal {
  const { authTime, ...rest } = input;
  return { ...rest, authTime: authTime ?? Math.floor(Date.now() / 1000) };
}

/** True when the principal's credential has passed its expiry. */
export function isExpired(
  principal: Principal,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return principal.expiresAt !== undefined && principal.expiresAt <= nowSeconds;
}

/** True when every entry of `required` appears in the principal's `amr`. */
export function hasAmr(principal: Principal, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const present = new Set(principal.amr ?? []);
  return required.every((value) => present.has(value));
}
