import type { AuthErrorCode, AuthFailure } from './result.ts';

/**
 * The one error type for both transports.
 *
 * `AuthError` is structurally compatible with itty-router's `StatusError` (both
 * expose `.status`), and it carries an `extensions` property that graphql-js
 * picks up automatically — `GraphQLError`'s constructor does
 * `this.extensions = extensions ?? originalError?.extensions ?? {}`, so throwing
 * one of these from a resolver produces `errors[0].extensions.code ===
 * 'UNAUTHENTICATED'` without this package importing `graphql` at all. That is
 * what keeps `graphql` a genuinely optional peer dependency.
 */

/**
 * Generic, non-enumerating text sent to the client. The detailed reason stays in
 * `message`, which goes to logs only.
 *
 * Every credential-rejection code maps to the same string on purpose: a login
 * endpoint that says "no such user" for one input and "wrong password" for
 * another is a user-enumeration oracle. Making the public text a lookup rather
 * than a per-call decision means it cannot be got wrong at a call site.
 */
const PUBLIC_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  no_credential: 'Authentication required',
  invalid_credentials: 'Invalid credentials',
  malformed_credential: 'Invalid credentials',
  account_disabled: 'Invalid credentials',
  throttled: 'Too many attempts, try again later',
  weak_password: 'Password does not meet the minimum requirements',
  session_expired: 'Session expired',
  session_not_found: 'Session expired',
  csrf_failed: 'Request rejected',
  invalid_token: 'Invalid token',
  token_expired: 'Token expired',
  token_not_yet_valid: 'Invalid token',
  invalid_signature: 'Invalid token',
  invalid_algorithm: 'Invalid token',
  invalid_issuer: 'Invalid token',
  invalid_audience: 'Invalid token',
  refresh_token_reused: 'Session revoked',
  refresh_token_expired: 'Session expired',
  challenge_not_found: 'Challenge expired or already used',
  origin_mismatch: 'Request rejected',
  credential_exists: 'Credential already registered',
  credential_not_found: 'Credential not recognised',
  clone_detected: 'Authenticator rejected',
  attestation_unsupported: 'Authenticator rejected',
  oauth_error: 'Sign-in failed',
  state_mismatch: 'Sign-in failed',
  nonce_mismatch: 'Sign-in failed',
  issuer_mismatch: 'Sign-in failed',
  discovery_failed: 'Sign-in temporarily unavailable',
};

const DEFAULT_PUBLIC_MESSAGE = 'Authentication failed';

export interface AuthErrorOptions {
  status?: number;
  code?: AuthErrorCode;
  cause?: unknown;
  /** Structured detail for logs. Never serialised onto the wire. */
  detail?: unknown;
  /** Override the client-visible text. Use sparingly. */
  publicMessage?: string;
  /** `WWW-Authenticate` values. Multiple entries produce multiple headers. */
  challenges?: readonly string[];
}

export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly status: number;
  readonly code: AuthErrorCode;
  readonly publicMessage: string;
  readonly detail?: unknown;
  readonly challenges: readonly string[];
  /** Read by graphql-js via `originalError.extensions`. */
  readonly extensions: {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';
    readonly reason: AuthErrorCode;
  };

  constructor(message: string, options: AuthErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = options.code ?? 'invalid_credentials';
    this.status = options.status ?? (this.code === 'csrf_failed' ? 403 : 401);
    this.publicMessage =
      options.publicMessage ?? PUBLIC_MESSAGES[this.code] ?? DEFAULT_PUBLIC_MESSAGE;
    this.challenges = options.challenges ?? [];
    if (options.detail !== undefined) this.detail = options.detail;
    this.extensions = {
      code: this.status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED',
      reason: this.code,
    };
  }

  static unauthenticated(message = 'No credential presented'): AuthError {
    return new AuthError(message, { code: 'no_credential' });
  }

  /** Lift an {@link AuthFailure} from a strategy chain into a throwable error. */
  static fromFailure(failure: AuthFailure, challenges: readonly string[] = []): AuthError {
    return new AuthError(failure.message, {
      code: failure.code,
      status: failure.status,
      challenges: failure.challenge ? [failure.challenge, ...challenges] : challenges,
    });
  }

  /**
   * Serialise for the wire. Only `publicMessage` and `code` are included —
   * `message` and `detail` stay server-side.
   */
  toJSON(): { error: string; code: AuthErrorCode } {
    return { error: this.publicMessage, code: this.code };
  }

  /**
   * A copy whose `message` is the client-safe text.
   *
   * The HTTP path never serialises `message` — `toResponse` writes `toJSON`.
   * GraphQL is different: graphql-js copies `originalError.message` verbatim
   * into `errors[0].message`, so throwing a raw `AuthError` from a resolver
   * would put the detailed, log-facing message on the wire. Resolver-facing
   * throw sites use this instead; the original is kept as `cause` so a logger
   * can still see why.
   */
  redacted(): AuthError {
    if (this.message === this.publicMessage) return this;
    return new AuthError(this.publicMessage, {
      code: this.code,
      status: this.status,
      publicMessage: this.publicMessage,
      challenges: this.challenges,
      cause: this,
    });
  }

  toResponse(init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    // `append`, not `set`: RFC 9110 allows multiple challenges and a client may
    // pick whichever scheme it can satisfy.
    for (const challenge of this.challenges) headers.append('WWW-Authenticate', challenge);
    return new Response(JSON.stringify(this.toJSON()), {
      ...init,
      status: init.status ?? this.status,
      headers,
    });
  }
}

/**
 * Alias for GraphQL call sites. Same class, same behaviour — one error type
 * serving two transports.
 */
export const AuthenticationError = AuthError;

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
