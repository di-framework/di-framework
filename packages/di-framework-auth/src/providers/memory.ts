import type {
  ApiKeyCredential,
  AuthStores,
  CredentialStore,
  KeyStore,
  LoginThrottle,
  PasswordCredential,
  RefreshRotateResult,
  RefreshTokenRecord,
  RefreshTokenStore,
  SessionRecord,
  SessionStore,
  SigningKeyRecord,
  StateEntry,
  StatePurpose,
  StateStore,
  ThrottleDecision,
  UserRecord,
  UserStore,
  WebAuthnCredential,
} from './types.ts';

/**
 * In-memory reference implementations.
 *
 * Intended for development, tests, and single-process deployments. The ATOMIC
 * contracts documented on `StateStore.consume`, `RefreshTokenStore.rotate`, and
 * `CredentialStore.updateSignCount` hold here for free: JavaScript is
 * single-threaded, and none of these methods `await` between reading and
 * writing, so no other task can interleave.
 *
 * Everything is lost on restart. Sessions, OAuth state, and WebAuthn challenges
 * all vanish, which is why this warns once outside development.
 */

export interface MemoryStoreOptions {
  now?: () => number;
  /** Suppress the production warning — useful when memory storage is intentional. */
  silent?: boolean;
}

let warned = false;

function warnIfProduction(silent: boolean): void {
  if (silent || warned) return;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.NODE_ENV;
  if (env === 'production') {
    warned = true;
    console.warn(
      '[@di-framework/auth] inMemoryAuthStores() is in use with NODE_ENV=production. ' +
        'Sessions, OAuth state, and WebAuthn challenges are held in process memory and are ' +
        'lost on restart and not shared between instances. Use a persistent store.',
    );
  }
}

const seconds = () => Math.floor(Date.now() / 1000);

/** Case-insensitive identifier key, so `Ada@example.com` and `ada@example.com` are one user. */
function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function withIdentifierKey(user: UserRecord): UserRecord {
  const identifier = user.identifier.trim();
  return { ...user, identifier, identifierKey: identifier.toLowerCase() };
}

export function memoryUserStore(_options: MemoryStoreOptions = {}): UserStore {
  const byId = new Map<string, UserRecord>();
  const byIdentifier = new Map<string, string>();
  const byHandle = new Map<string, string>();

  const index = (user: UserRecord): void => {
    byIdentifier.set(normalizeIdentifier(user.identifier), user.id);
    if (user.webauthnUserHandle) byHandle.set(user.webauthnUserHandle, user.id);
  };

  return {
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async findByIdentifier(identifier) {
      const id = byIdentifier.get(normalizeIdentifier(identifier));
      return id ? (byId.get(id) ?? null) : null;
    },
    async findByWebAuthnHandle(handle) {
      const id = byHandle.get(handle);
      return id ? (byId.get(id) ?? null) : null;
    },
    async create(user) {
      if (byId.has(user.id)) throw new Error(`User '${user.id}' already exists`);
      if (byIdentifier.has(normalizeIdentifier(user.identifier))) {
        throw new Error(`Identifier '${user.identifier}' is already registered`);
      }
      // `identifierKey` is maintained here too, so a record round-tripped
      // through either store carries the same shape.
      const stored = withIdentifierKey(user);
      byId.set(stored.id, stored);
      index(stored);
      return stored;
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) return null;
      if (
        patch.identifier &&
        normalizeIdentifier(patch.identifier) !== normalizeIdentifier(existing.identifier)
      ) {
        byIdentifier.delete(normalizeIdentifier(existing.identifier));
      }
      const updated = withIdentifierKey({ ...existing, ...patch, id });
      byId.set(id, updated);
      index(updated);
      return updated;
    },
    async delete(id) {
      const existing = byId.get(id);
      if (!existing) return false;
      byId.delete(id);
      byIdentifier.delete(normalizeIdentifier(existing.identifier));
      if (existing.webauthnUserHandle) byHandle.delete(existing.webauthnUserHandle);
      return true;
    },
  };
}

export function memorySessionStore(options: MemoryStoreOptions = {}): SessionStore {
  const _now = options.now ?? seconds;
  const sessions = new Map<string, SessionRecord>();
  const bySubject = new Map<string, Set<string>>();

  return {
    async get(id) {
      // Returns the record as stored, expired or not. Evaluating the absolute
      // and inactivity timeouts is `SessionManager`'s job — doing it here as
      // well would mean two places deciding what "expired" means, and the store
      // would silently reclassify an absolute expiry as a missing session.
      return sessions.get(id) ?? null;
    },
    async create(session) {
      sessions.set(session.id, session);
      let set = bySubject.get(session.subject);
      if (!set) {
        set = new Set();
        bySubject.set(session.subject, set);
      }
      set.add(session.id);
      return session;
    },
    async touch(id, lastSeenAt) {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, lastSeenAt });
    },
    async delete(id) {
      const session = sessions.get(id);
      if (!session) return false;
      sessions.delete(id);
      bySubject.get(session.subject)?.delete(id);
      return true;
    },
    async deleteBySubject(subject) {
      const ids = bySubject.get(subject);
      if (!ids) return 0;
      let count = 0;
      for (const id of ids) if (sessions.delete(id)) count++;
      bySubject.delete(subject);
      return count;
    },
    async purgeExpired(at) {
      let count = 0;
      for (const [id, session] of sessions) {
        if (session.absoluteExpiresAt <= at) {
          sessions.delete(id);
          bySubject.get(session.subject)?.delete(id);
          count++;
        }
      }
      return count;
    },
  };
}

export function memoryCredentialStore(_options: MemoryStoreOptions = {}): CredentialStore {
  const passwords = new Map<string, PasswordCredential>();
  const webauthn = new Map<string, WebAuthnCredential>();
  const apiKeys = new Map<string, ApiKeyCredential>();

  return {
    async findPassword(userId) {
      return passwords.get(userId) ?? null;
    },
    async savePassword(credential) {
      passwords.set(credential.userId, credential);
      return credential;
    },
    async deletePassword(userId) {
      return passwords.delete(userId);
    },

    async findWebAuthn(credentialId) {
      return webauthn.get(credentialId) ?? null;
    },
    async listWebAuthn(userId) {
      return [...webauthn.values()].filter((credential) => credential.userId === userId);
    },
    async saveWebAuthn(credential) {
      webauthn.set(credential.id, credential);
      return credential;
    },
    async deleteWebAuthn(credentialId) {
      return webauthn.delete(credentialId);
    },
    async updateSignCount(credentialId, signCount, expectedVersion, lastUsedAt, backupState) {
      // Compare-and-swap. No `await` between the read and the write, so this is
      // indivisible on a single-threaded runtime.
      const credential = webauthn.get(credentialId);
      if (!credential || credential.version !== expectedVersion) return false;
      webauthn.set(credentialId, {
        ...credential,
        signCount,
        lastUsedAt,
        ...(backupState !== undefined ? { backupState } : {}),
        version: credential.version + 1,
      });
      return true;
    },

    async findApiKey(hashedKey) {
      return apiKeys.get(hashedKey) ?? null;
    },
    async listApiKeys(userId) {
      return [...apiKeys.values()].filter((credential) => credential.userId === userId);
    },
    async saveApiKey(credential) {
      apiKeys.set(credential.id, credential);
      return credential;
    },
    async deleteApiKey(hashedKey) {
      return apiKeys.delete(hashedKey);
    },
  };
}

export function memoryStateStore(options: MemoryStoreOptions = {}): StateStore {
  const now = options.now ?? seconds;
  const entries = new Map<string, StateEntry>();
  const compose = (purpose: StatePurpose, key: string) => `${purpose} ${key}`;

  return {
    async put(entry) {
      entries.set(compose(entry.purpose, entry.key), entry);
    },
    async consume<T = Record<string, unknown>>(purpose: StatePurpose, key: string) {
      // Read-and-delete with no interleaving point: single-use is guaranteed.
      const composed = compose(purpose, key);
      const entry = entries.get(composed);
      if (!entry) return null;
      entries.delete(composed);
      if (entry.expiresAt <= now()) return null;
      return entry as StateEntry<T>;
    },
    async purgeExpired(at) {
      let count = 0;
      for (const [composed, entry] of entries) {
        if (entry.expiresAt <= at) {
          entries.delete(composed);
          count++;
        }
      }
      return count;
    },
  };
}

export function memoryRefreshTokenStore(options: MemoryStoreOptions = {}): RefreshTokenStore {
  const now = options.now ?? seconds;
  const tokens = new Map<string, RefreshTokenRecord>();
  const byFamily = new Map<string, Set<string>>();
  const bySubject = new Map<string, Set<string>>();

  const track = (record: RefreshTokenRecord): void => {
    let family = byFamily.get(record.familyId);
    if (!family) {
      family = new Set();
      byFamily.set(record.familyId, family);
    }
    family.add(record.id);

    let subject = bySubject.get(record.subject);
    if (!subject) {
      subject = new Set();
      bySubject.set(record.subject, subject);
    }
    subject.add(record.id);
  };

  return {
    async issue(record) {
      tokens.set(record.id, record);
      track(record);
      return record;
    },
    async find(id) {
      return tokens.get(id) ?? null;
    },
    async rotate(id, next, rotatedAt): Promise<RefreshRotateResult> {
      // Compare-and-swap on `rotatedAt`. The whole reuse-detection scheme rests
      // on this being indivisible.
      const record = tokens.get(id);
      if (!record) return { outcome: 'not-found' };
      if (record.rotatedAt !== undefined) return { outcome: 'reused', record };
      if (record.expiresAt <= now()) return { outcome: 'expired', record };
      tokens.set(id, { ...record, rotatedAt });
      tokens.set(next.id, next);
      track(next);
      return { outcome: 'rotated', record: next };
    },
    async revokeFamily(familyId) {
      const ids = byFamily.get(familyId);
      if (!ids) return 0;
      let count = 0;
      for (const id of ids) if (tokens.delete(id)) count++;
      byFamily.delete(familyId);
      return count;
    },
    async revokeBySubject(subject) {
      const ids = bySubject.get(subject);
      if (!ids) return 0;
      let count = 0;
      for (const id of ids) if (tokens.delete(id)) count++;
      bySubject.delete(subject);
      return count;
    },
    async purgeExpired(at) {
      let count = 0;
      for (const [id, record] of tokens) {
        if (record.expiresAt <= at) {
          tokens.delete(id);
          count++;
        }
      }
      return count;
    },
  };
}

export function memoryKeyStore(options: MemoryStoreOptions = {}): KeyStore {
  const now = options.now ?? seconds;
  const keys = new Map<string, SigningKeyRecord>();
  let currentKid: string | undefined;

  return {
    async current() {
      const key = currentKid ? keys.get(currentKid) : undefined;
      if (!key) {
        throw new Error(
          'No signing key registered. Call `keyStore.save(await generateSigningKey())` or use ' +
            '`registerAuth({ jwt: { ... } })`, which generates one on first use.',
        );
      }
      return key;
    },
    async all() {
      const at = now();
      const live = [...keys.values()].filter((key) => !key.expiresAt || key.expiresAt > at);
      // Current key first, so a JWKS consumer trying keys in order usually hits
      // on the first attempt.
      live.sort((a, b) =>
        a.kid === currentKid ? -1 : b.kid === currentKid ? 1 : b.createdAt - a.createdAt,
      );
      return live;
    },
    async find(kid) {
      return keys.get(kid) ?? null;
    },
    async save(key) {
      keys.set(key.kid, key);
      const at = now();
      // Newly saved keys become current unless they are already past `notAfter`.
      if (!key.notAfter || key.notAfter > at) currentKid = key.kid;
      return key;
    },
    async delete(kid) {
      if (currentKid === kid) currentKid = undefined;
      return keys.delete(kid);
    },
  };
}

export interface MemoryThrottleOptions extends MemoryStoreOptions {
  /** Failures tolerated inside one window before the bucket locks. Default 10. */
  maxAttempts?: number;
  /** Window length in seconds. Default 900 (15 minutes). */
  windowSeconds?: number;
}

/**
 * Fixed-window failure counter.
 *
 * NIST SP 800-63B §5.2.2 caps consecutive failed attempts at 100; the default
 * here is far stricter because a legitimate user rarely needs ten tries and the
 * cost of a lower limit is a support ticket rather than a breach.
 */
export function memoryLoginThrottle(options: MemoryThrottleOptions = {}): LoginThrottle {
  const now = options.now ?? seconds;
  const maxAttempts = options.maxAttempts ?? 10;
  const windowSeconds = options.windowSeconds ?? 900;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const read = (key: string): { count: number; resetAt: number } => {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) return { count: 0, resetAt: at + windowSeconds };
    return bucket;
  };

  const decide = (bucket: { count: number; resetAt: number }): ThrottleDecision => {
    const allowed = bucket.count < maxAttempts;
    return {
      allowed,
      remaining: Math.max(0, maxAttempts - bucket.count),
      retryAfter: allowed ? 0 : Math.max(1, bucket.resetAt - now()),
    };
  };

  return {
    async check(key) {
      return decide(read(key));
    },
    async fail(key) {
      const bucket = read(key);
      const updated = { count: bucket.count + 1, resetAt: bucket.resetAt };
      buckets.set(key, updated);
      return decide(updated);
    },
    async reset(key) {
      buckets.delete(key);
    },
  };
}

/** Every in-memory store, wired together. */
export function inMemoryAuthStores(options: MemoryStoreOptions = {}): AuthStores {
  warnIfProduction(options.silent === true);
  return {
    users: memoryUserStore(options),
    sessions: memorySessionStore(options),
    credentials: memoryCredentialStore(options),
    state: memoryStateStore(options),
    refreshTokens: memoryRefreshTokenStore(options),
    keys: memoryKeyStore(options),
    throttle: memoryLoginThrottle(options),
  };
}
