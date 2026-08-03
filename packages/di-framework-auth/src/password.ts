import type { PasswordHasher } from './crypto/password-hasher.ts';
import { randomId, randomToken } from './crypto/random.ts';
import { AuthError } from './errors.ts';
import { createPrincipal, type Principal } from './principal.ts';
import type {
  CredentialStore,
  LoginThrottle,
  PasswordCredential,
  UserRecord,
  UserStore,
} from './providers/types.ts';

/**
 * Password policy, per NIST SP 800-63B §5.1.1.2 (rev 3) / §3.1.1 (rev 4).
 *
 * What that guidance actually says, and what this implements:
 * - minimum 8 characters, and verifiers **must** accept at least 64;
 * - all printable ASCII and Unicode accepted, spaces included;
 * - **no composition rules** — no "must contain a digit and a symbol";
 * - **no periodic rotation** — only force a change on evidence of compromise;
 * - check candidates against a list of commonly used or breached passwords.
 *
 * The composition rules and forced rotation that most systems still impose are
 * explicitly recommended *against*, because they push users toward predictable
 * mutations. There is deliberately no option to turn them on.
 */
export interface PasswordPolicy {
  /** Default 8, the NIST floor. Consider 15 for administrative accounts. */
  minLength?: number;
  /**
   * Default 256. Must not be set below 64 — truncating long passphrases is
   * itself a weakness, and SP 800-63B requires accepting at least 64 characters.
   */
  maxLength?: number;
  /**
   * Upper bound on UTF-8 byte length, default 1024. This is a denial-of-service
   * bound, not a policy: PBKDF2 cost scales with input size.
   */
  maxBytes?: number;
  /**
   * Return `true` when the password appears in a breach corpus or common-password
   * list. The seam for a k-anonymity Have I Been Pwned client or a local list.
   */
  breachedCheck?: (password: string) => Promise<boolean> | boolean;
}

export interface PasswordService {
  /** Validate against policy. Throws `AuthError('weak_password')` on failure. */
  validate(password: string): Promise<void>;
  /** Hash and store a password for an existing user. */
  register(userId: string, password: string): Promise<PasswordCredential>;
  /** Verify without the throttle or user lookup. Prefer {@link login}. */
  verify(userId: string, password: string): Promise<boolean>;
  changePassword(userId: string, current: string, next: string): Promise<void>;
  /**
   * Full login: throttle check, user lookup, constant-time verification,
   * transparent rehash, throttle reset.
   */
  login(identifier: string, password: string): Promise<{ user: UserRecord; principal: Principal }>;
  /** Create a user together with their initial password. */
  createUser(input: {
    identifier: string;
    password: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UserRecord>;
}

export interface PasswordServiceOptions {
  users: UserStore;
  credentials: CredentialStore;
  hasher: PasswordHasher;
  throttle?: LoginThrottle;
  policy?: PasswordPolicy;
  now?: () => number;
}

const MIN_ACCEPTED_MAX_LENGTH = 64;

export function passwordService(options: PasswordServiceOptions): PasswordService {
  const { users, credentials, hasher, throttle } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const minLength = options.policy?.minLength ?? 8;
  const maxLength = options.policy?.maxLength ?? 256;
  const maxBytes = options.policy?.maxBytes ?? 1024;
  const breachedCheck = options.policy?.breachedCheck;

  if (maxLength < MIN_ACCEPTED_MAX_LENGTH) {
    throw new RangeError(
      `PasswordPolicy.maxLength must be at least ${MIN_ACCEPTED_MAX_LENGTH}; NIST SP 800-63B ` +
        'requires verifiers to accept passwords of at least 64 characters.',
    );
  }

  const weak = (message: string): never => {
    throw new AuthError(message, { code: 'weak_password', status: 400, publicMessage: message });
  };

  const validate: PasswordService['validate'] = async (password) => {
    if (typeof password !== 'string') weak('Password must be a string');
    // Count code points, not UTF-16 units, so an emoji is one character.
    const length = [...password].length;
    if (length < minLength) weak(`Password must be at least ${minLength} characters`);
    if (length > maxLength) weak(`Password must be at most ${maxLength} characters`);
    if (new TextEncoder().encode(password).length > maxBytes) {
      weak(`Password must be at most ${maxBytes} bytes`);
    }
    if (breachedCheck && (await breachedCheck(password))) {
      weak('This password has appeared in a known data breach and cannot be used');
    }
  };

  const store = async (userId: string, password: string): Promise<PasswordCredential> => {
    const at = now();
    const existing = await credentials.findPassword(userId);
    return credentials.savePassword({
      kind: 'password',
      id: existing?.id ?? randomId(),
      userId,
      hash: await hasher.hash(password),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
  };

  return {
    validate,

    async register(userId, password) {
      await validate(password);
      return store(userId, password);
    },

    async verify(userId, password) {
      const credential = await credentials.findPassword(userId);
      // Still burn the work when there is no credential, so the timing of "user
      // has no password set" is indistinguishable from "wrong password".
      if (!credential) return hasher.verifyDummy(password);
      return hasher.verify(password, credential.hash);
    },

    async changePassword(userId, current, next) {
      const credential = await credentials.findPassword(userId);
      if (!credential || !(await hasher.verify(current, credential.hash))) {
        throw new AuthError('Current password did not match', { code: 'invalid_credentials' });
      }
      await validate(next);
      await store(userId, next);
      // Callers should follow this with `sessions.revokeAllForSubject(userId)`;
      // see the README's "After a password change" note.
    },

    async login(identifier, password) {
      const throttleKey = `password:${identifier.trim().toLowerCase()}`;

      if (throttle) {
        const decision = await throttle.check(throttleKey);
        if (!decision.allowed) {
          throw new AuthError(`Login throttled for '${identifier}'`, {
            code: 'throttled',
            status: 429,
            detail: { retryAfter: decision.retryAfter },
          });
        }
      }

      const user = await users.findByIdentifier(identifier);
      const credential = user ? await credentials.findPassword(user.id) : null;

      // One branch, one cost. Whether the user is missing, has no password, or
      // typed the wrong one, the work done and the error returned are identical
      // — otherwise this endpoint tells an attacker which accounts exist.
      const matched = credential
        ? await hasher.verify(password, credential.hash)
        : await hasher.verifyDummy(password);

      if (!user || !credential || !matched || user.disabled) {
        if (throttle) await throttle.fail(throttleKey);
        throw new AuthError(
          !user
            ? `No user for identifier '${identifier}'`
            : !credential
              ? `User '${user.id}' has no password credential`
              : user.disabled
                ? `User '${user.id}' is disabled`
                : `Password mismatch for user '${user.id}'`,
          { code: 'invalid_credentials' },
        );
      }

      if (throttle) await throttle.reset(throttleKey);

      // Transparent upgrade: the user just proved the plaintext, so this is the
      // only moment we can re-hash with stronger parameters.
      if (hasher.needsRehash(credential.hash)) {
        await store(user.id, password);
      }

      return {
        user,
        principal: createPrincipal({
          sub: user.id,
          method: 'password',
          amr: ['pwd'],
          authTime: now(),
        }),
      };
    },

    async createUser(input) {
      await validate(input.password);
      const existing = await users.findByIdentifier(input.identifier);
      if (existing) {
        throw new AuthError(`Identifier '${input.identifier}' is already registered`, {
          code: 'invalid_credentials',
          status: 409,
          publicMessage: 'Unable to complete registration',
        });
      }
      const user = await users.create({
        id: randomId(),
        identifier: input.identifier.trim(),
        createdAt: now(),
        webauthnUserHandle: randomToken(32),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      await store(user.id, input.password);
      return user;
    },
  };
}
