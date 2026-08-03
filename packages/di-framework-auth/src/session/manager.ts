import { hashSecret } from '../crypto/hash.ts';
import { randomToken } from '../crypto/random.ts';
import { createPrincipal, type Principal } from '../principal.ts';
import type { SessionRecord, SessionStore } from '../providers/types.ts';
import { resolveSessionPolicy, type SessionPolicy } from './policy.ts';

/**
 * Server-side sessions.
 *
 * The token the client holds is 256 bits of randomness; the store only ever sees
 * its SHA-256. A dump of the session table therefore does not hand an attacker
 * a set of live sessions. See `../crypto/hash.ts` for why a password KDF would
 * be the wrong tool here.
 */

export interface CreateSessionInput {
  subject: string;
  amr?: readonly string[];
  acr?: string;
  /** Defaults to now. Preserved across regeneration so `max_age` stays meaningful. */
  authTime?: number;
  metadata?: Record<string, unknown>;
}

export interface IssuedSession {
  /** The value that goes in the cookie. Never stored. */
  token: string;
  record: SessionRecord;
  principal: Principal;
}

export type SessionLookup =
  | { state: 'active'; record: SessionRecord; principal: Principal }
  | { state: 'not-found' }
  | { state: 'expired'; reason: 'absolute' | 'inactivity' };

export interface SessionManager {
  readonly policy: SessionPolicy;
  create(input: CreateSessionInput): Promise<IssuedSession>;
  /** Resolve a raw cookie value. Touches `lastSeenAt` subject to the policy interval. */
  resolve(token: string): Promise<SessionLookup>;
  /**
   * Issue a fresh session id for an existing session and destroy the old one.
   *
   * Must be called immediately after authentication and on any privilege change.
   * A session id that the client held *before* authenticating and still holds
   * after is a session-fixation vulnerability: an attacker who planted that id
   * is now sharing the victim's authenticated session.
   */
  regenerate(token: string, changes?: Partial<CreateSessionInput>): Promise<IssuedSession | null>;
  revoke(token: string): Promise<boolean>;
  revokeAllForSubject(subject: string): Promise<number>;
  /** Hash a raw token into its store key. Exposed for callers holding a record id. */
  keyOf(token: string): Promise<string>;
}

export interface SessionManagerOptions {
  store: SessionStore;
  policy?: Partial<SessionPolicy>;
  /** Session token entropy in bytes. Default 32 (256 bits). */
  tokenBytes?: number;
  now?: () => number;
  /** Mint a per-session CSRF secret. Default on. */
  csrf?: boolean;
}

export function sessionManager(options: SessionManagerOptions): SessionManager {
  const { store } = options;
  const policy = resolveSessionPolicy(options.policy);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokenBytes = options.tokenBytes ?? 32;
  const withCsrf = options.csrf !== false;

  const toPrincipal = (record: SessionRecord): Principal =>
    createPrincipal({
      sub: record.subject,
      method: 'session',
      authTime: record.authTime,
      sessionId: record.id,
      expiresAt: record.absoluteExpiresAt,
      ...(record.amr ? { amr: record.amr } : {}),
      ...(record.acr ? { acr: record.acr } : {}),
      ...(record.metadata ? { claims: record.metadata } : {}),
    });

  const expiryReason = (record: SessionRecord, at: number): 'absolute' | 'inactivity' | null => {
    if (record.absoluteExpiresAt <= at) return 'absolute';
    if (
      policy.inactivityTimeoutSeconds > 0 &&
      record.lastSeenAt + policy.inactivityTimeoutSeconds <= at
    ) {
      return 'inactivity';
    }
    return null;
  };

  const mint = async (input: CreateSessionInput, at: number): Promise<IssuedSession> => {
    const token = randomToken(tokenBytes);
    const authTime = input.authTime ?? at;
    const record: SessionRecord = {
      id: await hashSecret(token),
      subject: input.subject,
      createdAt: at,
      authTime,
      lastSeenAt: at,
      absoluteExpiresAt: authTime + policy.absoluteTimeoutSeconds,
      ...(input.amr ? { amr: input.amr } : {}),
      ...(input.acr ? { acr: input.acr } : {}),
      ...(withCsrf ? { csrfSecret: randomToken(16) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const stored = await store.create(record);
    return { token, record: stored, principal: toPrincipal(stored) };
  };

  return {
    policy,

    create(input) {
      return mint(input, now());
    },

    async resolve(token) {
      if (!token) return { state: 'not-found' };
      const id = await hashSecret(token);
      const record = await store.get(id);
      if (!record) return { state: 'not-found' };

      const at = now();
      const expired = expiryReason(record, at);
      if (expired) {
        await store.delete(id);
        return { state: 'expired', reason: expired };
      }

      // Throttled so a busy session does not write on every request.
      if (at - record.lastSeenAt >= policy.touchIntervalSeconds) {
        await store.touch(id, at);
      }

      return { state: 'active', record, principal: toPrincipal(record) };
    },

    async regenerate(token, changes = {}) {
      const id = await hashSecret(token);
      const existing = await store.get(id);
      if (!existing) return null;

      const at = now();
      if (expiryReason(existing, at)) {
        await store.delete(id);
        return null;
      }

      const issued = await mint(
        {
          subject: changes.subject ?? existing.subject,
          // `authTime` survives regeneration unless the caller re-authenticated.
          authTime: changes.authTime ?? existing.authTime,
          ...((changes.amr ?? existing.amr) ? { amr: changes.amr ?? existing.amr } : {}),
          ...((changes.acr ?? existing.acr) ? { acr: changes.acr ?? existing.acr } : {}),
          ...((changes.metadata ?? existing.metadata)
            ? { metadata: changes.metadata ?? existing.metadata }
            : {}),
        },
        at,
      );
      // Destroy the old id only after the new one exists, so a crash between the
      // two leaves the user logged in rather than logged out.
      await store.delete(id);
      return issued;
    },

    async revoke(token) {
      return store.delete(await hashSecret(token));
    },

    revokeAllForSubject(subject) {
      return store.deleteBySubject(subject);
    },

    keyOf: hashSecret,
  };
}
