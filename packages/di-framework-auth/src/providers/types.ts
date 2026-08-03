/**
 * Storage provider interfaces.
 *
 * Every backend this package talks to is described here and nowhere else.
 * Implementations are factory functions returning object literals, matching the
 * convention set by `@di-framework/events`' `EventTransport` and
 * `@di-framework/config`'s `ConfigSource`.
 *
 * Two invariants every implementation must honour:
 *
 * 1. **What is stored hashed.** Session ids, refresh tokens, and API keys reach
 *    these stores already SHA-256 hashed — the store never sees the plaintext,
 *    so a database dump is not a set of live credentials. Passwords arrive as a
 *    PBKDF2 PHC string. Nothing else is hashed.
 *
 * 2. **Where atomicity is required.** `StateStore.consume`,
 *    `RefreshTokenStore.rotate`, and `CredentialStore.updateSignCount` are the
 *    replay defences for OAuth `state`, refresh tokens, and WebAuthn sign
 *    counters respectively. Each must be a compare-and-swap. Implemented as a
 *    read followed by a write, two concurrent replays both read the old state,
 *    both see it as unused, and both succeed — the defence silently does
 *    nothing. Methods that require this are marked ATOMIC below.
 */

export interface UserRecord {
  id: string;
  /** Login identifier — email, username, whatever your app uses. Unique. */
  identifier: string;
  /**
   * Lower-cased `identifier`, maintained by the store and used for lookup.
   *
   * Carried as a real field rather than relying on the backend's collation:
   * `Ada@Example.com` and `ada@example.com` are the same person, and whether a
   * query treats them that way otherwise depends on the database, the column,
   * and the index. Persisting the normalised form makes the behaviour identical
   * everywhere.
   */
  identifierKey?: string;
  displayName?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  /**
   * Opaque random handle for WebAuthn. WebAuthn L3 §5.4.3 forbids personally
   * identifying information here, so this must never be the email or a
   * sequential id. Generated on first passkey registration.
   */
  webauthnUserHandle?: string;
  createdAt: number;
  /** Free-form application data. This package never reads it. */
  metadata?: Record<string, unknown>;
}

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>;
  /** Lookup by login identifier. Implementations should treat this case-insensitively. */
  findByIdentifier(identifier: string): Promise<UserRecord | null>;
  findByWebAuthnHandle(handle: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<UserRecord>;
  update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface SessionRecord {
  /** SHA-256 of the session token. The plaintext never reaches the store. */
  id: string;
  subject: string;
  /** Seconds since the epoch. */
  createdAt: number;
  /** When the original authentication happened; preserved across regeneration. */
  authTime: number;
  lastSeenAt: number;
  /** Absolute expiry — a hard ceiling regardless of activity. */
  absoluteExpiresAt: number;
  amr?: readonly string[];
  acr?: string;
  /** Bound to the session so CSRF tokens cannot be transplanted between sessions. */
  csrfSecret?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  /**
   * Return the record as stored, expired or not.
   *
   * Stores are persistence, not policy: `SessionManager` evaluates the absolute
   * and inactivity timeouts. A store that filtered expired records here would
   * make an absolute expiry indistinguishable from a session that never existed,
   * which is exactly the distinction an audit log needs.
   */
  get(id: string): Promise<SessionRecord | null>;
  create(session: SessionRecord): Promise<SessionRecord>;
  /** Refresh `lastSeenAt`. Called on every authenticated request, so keep it cheap. */
  touch(id: string, lastSeenAt: number): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Invalidate every session for a subject — "sign out everywhere", password change. */
  deleteBySubject(subject: string): Promise<number>;
  /** Optional housekeeping hook; stores with native TTL can leave it undefined. */
  purgeExpired?(now: number): Promise<number>;
}

export type CredentialKind = 'password' | 'webauthn' | 'api-key';

export interface PasswordCredential {
  kind: 'password';
  id: string;
  userId: string;
  /** PHC-encoded hash, e.g. `$pbkdf2-sha256$i=600000$...`. */
  hash: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebAuthnCredential {
  kind: 'webauthn';
  /** base64url credential id. */
  id: string;
  userId: string;
  /** Raw COSE_Key bytes, base64url encoded. */
  publicKeyCose: string;
  /** COSE algorithm identifier: -7 (ES256), -257 (RS256), -8 (EdDSA). */
  algorithm: number;
  signCount: number;
  /**
   * Immutable for the life of the credential (WebAuthn L3 §6.1.3). A change
   * means a different authenticator or tampering, and is a hard failure.
   */
  backupEligible: boolean;
  /** May legitimately change as a passkey starts or stops syncing. */
  backupState: boolean;
  uvInitialized: boolean;
  aaguid?: string;
  transports?: readonly string[];
  attestationFormat?: string;
  createdAt: number;
  lastUsedAt?: number;
  disabled?: boolean;
  /** Optimistic-concurrency token for {@link CredentialStore.updateSignCount}. */
  version: number;
}

export interface ApiKeyCredential {
  kind: 'api-key';
  /** SHA-256 of the key. The plaintext is shown once, at creation, and never stored. */
  id: string;
  userId: string;
  label?: string;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  disabled?: boolean;
}

export type Credential = PasswordCredential | WebAuthnCredential | ApiKeyCredential;

export interface CredentialStore {
  findPassword(userId: string): Promise<PasswordCredential | null>;
  savePassword(credential: PasswordCredential): Promise<PasswordCredential>;
  deletePassword(userId: string): Promise<boolean>;

  findWebAuthn(credentialId: string): Promise<WebAuthnCredential | null>;
  listWebAuthn(userId: string): Promise<WebAuthnCredential[]>;
  saveWebAuthn(credential: WebAuthnCredential): Promise<WebAuthnCredential>;
  deleteWebAuthn(credentialId: string): Promise<boolean>;
  /**
   * ATOMIC. Must fail when the stored `version` differs from `expectedVersion`,
   * returning `false`. This is the WebAuthn clone/replay defence: without a
   * compare-and-swap, two concurrent replays of the same assertion both read the
   * old sign count, both see it as an increment, and both are accepted.
   */
  updateSignCount(
    credentialId: string,
    signCount: number,
    expectedVersion: number,
    lastUsedAt: number,
    backupState?: boolean,
  ): Promise<boolean>;

  findApiKey(hashedKey: string): Promise<ApiKeyCredential | null>;
  listApiKeys(userId: string): Promise<ApiKeyCredential[]>;
  saveApiKey(credential: ApiKeyCredential): Promise<ApiKeyCredential>;
  deleteApiKey(hashedKey: string): Promise<boolean>;
}

/** Short-lived single-use state: OAuth `state`/`nonce`/PKCE verifier, WebAuthn challenges. */
export type StatePurpose =
  | 'oauth-state'
  | 'webauthn-registration'
  | 'webauthn-authentication'
  | (string & {});

export interface StateEntry<T = Record<string, unknown>> {
  purpose: StatePurpose;
  key: string;
  data: T;
  expiresAt: number;
}

export interface StateStore {
  put(entry: StateEntry): Promise<void>;
  /**
   * ATOMIC. Read and delete in one indivisible operation, returning `null` when
   * the entry is missing, expired, or *already consumed*.
   *
   * This single method is what makes OAuth `state` and WebAuthn challenges
   * single-use. An implementation that reads, then deletes, is not sufficient:
   * two concurrent replays of the same callback both read the entry before
   * either delete lands, and the replay defence evaporates.
   */
  consume<T = Record<string, unknown>>(
    purpose: StatePurpose,
    key: string,
  ): Promise<StateEntry<T> | null>;
  purgeExpired?(now: number): Promise<number>;
}

export interface RefreshTokenRecord {
  /** SHA-256 of the token. */
  id: string;
  subject: string;
  /**
   * Groups every token descended from one login. Presenting a token that has
   * already been rotated revokes the whole family — the standard response to
   * refresh-token theft, since the legitimate client and the attacker cannot be
   * told apart and only one of them can hold the current token.
   */
  familyId: string;
  createdAt: number;
  expiresAt: number;
  /** Set when the token has been exchanged. A second presentation is reuse. */
  rotatedAt?: number;
  authTime: number;
  amr?: readonly string[];
  metadata?: Record<string, unknown>;
}

export type RefreshRotateResult =
  | { outcome: 'rotated'; record: RefreshTokenRecord }
  | { outcome: 'reused'; record: RefreshTokenRecord }
  | { outcome: 'not-found' }
  | { outcome: 'expired'; record: RefreshTokenRecord };

export interface RefreshTokenStore {
  issue(record: RefreshTokenRecord): Promise<RefreshTokenRecord>;
  /** Read without mutating. Used to build the successor before the swap. */
  find(id: string): Promise<RefreshTokenRecord | null>;
  /**
   * ATOMIC. Mark `id` rotated and store `next` in one indivisible operation.
   *
   * Returns `'reused'` when `id` was already rotated — the caller then calls
   * {@link revokeFamily}. Implemented non-atomically, two concurrent refreshes
   * both succeed and the reuse is never detected.
   */
  rotate(id: string, next: RefreshTokenRecord, rotatedAt: number): Promise<RefreshRotateResult>;
  revokeFamily(familyId: string): Promise<number>;
  revokeBySubject(subject: string): Promise<number>;
  purgeExpired?(now: number): Promise<number>;
}

/** A signing key with an overlapping validity window, so rotation is not a cliff. */
export interface SigningKeyRecord {
  kid: string;
  /** JWS `alg` this key signs with. */
  algorithm: string;
  /** Private key material, JWK-serialised. */
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
  createdAt: number;
  /** After this, the key still verifies but no longer signs. */
  notAfter?: number;
  /** After this, the key is removed from the JWKS entirely. */
  expiresAt?: number;
}

export interface KeyStore {
  /** The key new tokens are signed with. */
  current(): Promise<SigningKeyRecord>;
  /** Every key that should still verify, current first. Published as the JWKS. */
  all(): Promise<SigningKeyRecord[]>;
  find(kid: string): Promise<SigningKeyRecord | null>;
  save(key: SigningKeyRecord): Promise<SigningKeyRecord>;
  delete(kid: string): Promise<boolean>;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Attempts remaining before the bucket locks. */
  remaining: number;
  /** Seconds until the caller may try again; 0 when allowed. */
  retryAfter: number;
}

/**
 * Rate limiting for credential verification.
 *
 * NIST SP 800-63B §5.2.2 *requires* verifiers to throttle failed authentication
 * attempts. This is not decoration: PBKDF2 at 600,000 iterations is expensive
 * enough that an unthrottled login endpoint is a denial-of-service vector as
 * well as a password-guessing one.
 */
export interface LoginThrottle {
  /** Check without consuming. Called before the expensive hash comparison. */
  check(key: string): Promise<ThrottleDecision>;
  /** Record a failure and return the resulting decision. */
  fail(key: string): Promise<ThrottleDecision>;
  /** Clear the bucket after a successful authentication. */
  reset(key: string): Promise<void>;
}

/** The full set of stores the package can use. */
export interface AuthStores {
  users: UserStore;
  sessions: SessionStore;
  credentials: CredentialStore;
  state: StateStore;
  refreshTokens: RefreshTokenStore;
  keys: KeyStore;
  throttle: LoginThrottle;
}
