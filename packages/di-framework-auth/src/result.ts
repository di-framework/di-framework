import type { Principal } from './principal.ts';

/**
 * The outcome of running one {@link AuthStrategy} against a request.
 *
 * Three states, not two. The distinction between "no credential of my kind was
 * present" and "a credential of my kind was present and it was bad" is
 * load-bearing: the first means *try the next strategy*, the second means *stop
 * and reject*. Collapsing them lets a malformed bearer token silently fall
 * through to anonymous access, which is the failure mode this type exists to
 * prevent.
 */
export type AuthResult = AuthSuccess | AuthNoCredential | AuthFailure;

export interface AuthSuccess {
  readonly state: 'authenticated';
  readonly principal: Principal;
  /** Headers the strategy wants on the response, e.g. a rotated session cookie. */
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}

export interface AuthNoCredential {
  readonly state: 'no-credential';
}

export interface AuthFailure {
  readonly state: 'failed';
  readonly code: AuthErrorCode;
  /** HTTP status. 401 for a bad credential, 403 for a failed CSRF check. */
  readonly status: number;
  /** Full detail, for logs. Never sent to the client. */
  readonly message: string;
  /** `WWW-Authenticate` value, when the strategy has one. */
  readonly challenge?: string;
}

export type AuthErrorCode =
  // credential presentation
  | 'no_credential'
  | 'invalid_credentials'
  | 'malformed_credential'
  | 'account_disabled'
  | 'weak_password'
  | 'throttled'
  // sessions
  | 'session_expired'
  | 'session_not_found'
  | 'csrf_failed'
  // tokens
  | 'invalid_token'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'invalid_signature'
  | 'invalid_algorithm'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'refresh_token_reused'
  | 'refresh_token_expired'
  // webauthn
  | 'challenge_not_found'
  | 'origin_mismatch'
  | 'credential_exists'
  | 'credential_not_found'
  | 'clone_detected'
  | 'attestation_unsupported'
  // oauth
  | 'oauth_error'
  | 'state_mismatch'
  | 'nonce_mismatch'
  | 'issuer_mismatch'
  | 'discovery_failed'
  // configuration
  | 'unsupported_algorithm'
  | 'not_atomic';

export function authenticated(
  principal: Principal,
  headers?: ReadonlyArray<readonly [string, string]>,
): AuthSuccess {
  return headers?.length
    ? { state: 'authenticated', principal, headers }
    : { state: 'authenticated', principal };
}

const NO_CREDENTIAL: AuthNoCredential = { state: 'no-credential' };

export function noCredential(): AuthNoCredential {
  return NO_CREDENTIAL;
}

export function authFailed(
  code: AuthErrorCode,
  message: string,
  options: { status?: number; challenge?: string } = {},
): AuthFailure {
  return {
    state: 'failed',
    code,
    status: options.status ?? (code === 'csrf_failed' ? 403 : 401),
    message,
    ...(options.challenge !== undefined ? { challenge: options.challenge } : {}),
  };
}

export function isAuthenticated(result: AuthResult): result is AuthSuccess {
  return result.state === 'authenticated';
}

export function isNoCredential(result: AuthResult): result is AuthNoCredential {
  return result.state === 'no-credential';
}

export function isFailure(result: AuthResult): result is AuthFailure {
  return result.state === 'failed';
}
