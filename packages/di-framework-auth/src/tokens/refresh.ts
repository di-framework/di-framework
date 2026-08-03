import { hashSecret } from '../crypto/hash.ts';
import { randomId, randomToken } from '../crypto/random.ts';
import { AuthError } from '../errors.ts';
import { createPrincipal, type Principal } from '../principal.ts';
import type { RefreshTokenRecord, RefreshTokenStore } from '../providers/types.ts';

/**
 * Refresh tokens with rotation and reuse detection.
 *
 * Refresh tokens are **opaque random values, not JWTs**. A JWT refresh token
 * cannot be revoked without a server-side lookup, at which point it has all the
 * costs of an opaque token and none of the benefits. So: 256 bits of randomness,
 * stored as its SHA-256, one lookup per refresh.
 *
 * Every refresh rotates: the presented token is marked spent and a new one is
 * issued. If a spent token is presented again, one of two things happened — the
 * legitimate client retried after a dropped response, or an attacker is using a
 * stolen copy. They are indistinguishable from the server's position, and
 * exactly one party can hold the current token. So the entire family is revoked
 * and both parties must re-authenticate. That is the standard response (OAuth
 * 2.0 Security BCP, RFC 9700 §4.14.2), and it converts silent, indefinite token
 * theft into a visible, bounded logout.
 */

export interface RefreshServiceOptions {
  store: RefreshTokenStore;
  /** Refresh token lifetime in seconds. Default 30 days. */
  ttlSeconds?: number;
  /** Token entropy in bytes. Default 32 (256 bits). */
  tokenBytes?: number;
  now?: () => number;
  /** Called when a spent token is presented. Wire this to your alerting. */
  onReuseDetected?: (record: RefreshTokenRecord) => void | Promise<void>;
}

export interface IssuedRefreshToken {
  /** The value handed to the client. Never stored. */
  token: string;
  record: RefreshTokenRecord;
}

export interface RefreshedToken extends IssuedRefreshToken {
  principal: Principal;
}

export interface RefreshService {
  issue(input: {
    subject: string;
    authTime?: number;
    amr?: readonly string[];
    familyId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<IssuedRefreshToken>;
  /** Exchange a refresh token for a new one. Throws on reuse, expiry, or absence. */
  rotate(token: string): Promise<RefreshedToken>;
  revoke(token: string): Promise<void>;
  revokeAllForSubject(subject: string): Promise<number>;
}

export function refreshService(options: RefreshServiceOptions): RefreshService {
  const { store } = options;
  const ttlSeconds = options.ttlSeconds ?? 30 * 24 * 60 * 60;
  const tokenBytes = options.tokenBytes ?? 32;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const mint = async (
    subject: string,
    familyId: string,
    authTime: number,
    amr: readonly string[] | undefined,
    metadata: Record<string, unknown> | undefined,
    at: number,
  ): Promise<{ token: string; record: RefreshTokenRecord }> => {
    const token = randomToken(tokenBytes);
    const record: RefreshTokenRecord = {
      id: await hashSecret(token),
      subject,
      familyId,
      createdAt: at,
      expiresAt: at + ttlSeconds,
      authTime,
      ...(amr ? { amr } : {}),
      ...(metadata ? { metadata } : {}),
    };
    return { token, record };
  };

  return {
    async issue(input) {
      const at = now();
      const { token, record } = await mint(
        input.subject,
        input.familyId ?? randomId(),
        input.authTime ?? at,
        input.amr,
        input.metadata,
        at,
      );
      return { token, record: await store.issue(record) };
    },

    async rotate(token) {
      const at = now();
      const id = await hashSecret(token);

      const current = await store.find(id);
      if (!current) throw new AuthError('Refresh token not recognised', { code: 'invalid_token' });

      const burnFamily = async (record: RefreshTokenRecord): Promise<never> => {
        // Either a stolen token or a client retrying after a dropped response.
        // The two are indistinguishable from here and only one holder can have
        // the current token, so nobody keeps the family.
        await store.revokeFamily(record.familyId);
        await options.onReuseDetected?.(record);
        throw new AuthError(
          `Refresh token for family '${record.familyId}' was replayed; family revoked`,
          { code: 'refresh_token_reused' },
        );
      };

      if (current.rotatedAt !== undefined) await burnFamily(current);
      if (current.expiresAt <= at) {
        throw new AuthError(`Refresh token expired at ${current.expiresAt}`, {
          code: 'refresh_token_expired',
        });
      }

      // Mint the successor first, then hand both to the store so marking the old
      // token spent and persisting the new one happen as one compare-and-swap.
      // Losing that swap means a concurrent request already rotated this token —
      // which, from here, is indistinguishable from reuse and treated as such.
      const { token: nextToken, record: nextRecord } = await mint(
        current.subject,
        current.familyId,
        current.authTime,
        current.amr,
        current.metadata,
        at,
      );

      const result = await store.rotate(id, nextRecord, at);
      switch (result.outcome) {
        case 'rotated':
          break;
        case 'reused':
          await burnFamily(result.record);
          break;
        case 'expired':
          throw new AuthError(`Refresh token expired at ${result.record.expiresAt}`, {
            code: 'refresh_token_expired',
          });
        case 'not-found':
          throw new AuthError('Refresh token not recognised', { code: 'invalid_token' });
      }

      return {
        token: nextToken,
        record: nextRecord,
        principal: createPrincipal({
          sub: nextRecord.subject,
          method: 'bearer',
          authTime: nextRecord.authTime,
          ...(nextRecord.amr ? { amr: nextRecord.amr } : {}),
        }),
      };
    },

    async revoke(token) {
      const record = await store.find(await hashSecret(token));
      // Revoke the whole family: a logout that leaves the successor chain alive
      // would let a previously issued refresh token outlive the logout.
      if (record) await store.revokeFamily(record.familyId);
    },

    revokeAllForSubject(subject) {
      return store.revokeBySubject(subject);
    },
  };
}
