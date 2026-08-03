import { describe, expect, it } from 'bun:test';
import {
  adjustCookieName,
  assertCookiePolicy,
  clearCookie,
  parseCookies,
  serializeCookie,
} from '../src/cookies.ts';
import { pbkdf2Hasher } from '../src/crypto/password-hasher.ts';
import { checkRequestOrigin, csrfGuard, requiresCsrfCheck } from '../src/csrf.ts';
import { AuthError } from '../src/errors.ts';
import { passwordService } from '../src/password.ts';
import {
  memoryCredentialStore,
  memoryLoginThrottle,
  memorySessionStore,
  memoryUserStore,
} from '../src/providers/memory.ts';
import { sessionManager } from '../src/session/manager.ts';
import { AAL2_POLICY, resolveSessionPolicy } from '../src/session/policy.ts';

const SECRET = 's'.repeat(48);

describe('cookies', () => {
  it('applies secure defaults', () => {
    const cookie = serializeCookie('__Host-sid', 'abc');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });

  // A __Host- cookie that quietly loses Secure or gains a Domain no longer has
  // the property its name advertises, in a codebase where a reviewer will read
  // the name and assume it does.
  it('refuses to emit a __Host- cookie that violates the prefix', () => {
    expect(() => serializeCookie('__Host-sid', 'a', { secure: false })).toThrow(/requires Secure/);
    expect(() => serializeCookie('__Host-sid', 'a', { path: '/app' })).toThrow(/requires Path=\//);
    expect(() => assertCookiePolicy('__Secure-x', { secure: false })).toThrow(/requires Secure/);
  });

  it('downgrades __Host- to __Secure- when a Domain is requested', () => {
    // Browsers reject a __Host- cookie carrying Domain outright, so emitting one
    // would look like a bug elsewhere rather than a policy violation.
    expect(adjustCookieName('__Host-sid', { domain: 'example.com' })).toBe('__Secure-sid');
    expect(serializeCookie('__Host-sid', 'a', { domain: 'example.com' })).toContain(
      '__Secure-sid=a',
    );
  });

  it('rejects SameSite=None without Secure', () => {
    expect(() => serializeCookie('sid', 'a', { sameSite: 'None', secure: false })).toThrow(
      /requires Secure/,
    );
  });

  it('rejects invalid names and values', () => {
    expect(() => serializeCookie('bad name', 'a')).toThrow(/Invalid cookie name/);
    expect(() => serializeCookie('sid', 'a;b')).toThrow(/Invalid cookie value/);
  });

  it('parses a Cookie header, keeping the first of any duplicate', () => {
    expect(parseCookies('a=1; b=2; a=3')).toEqual({ a: '1', b: '2' });
    expect(parseCookies(null)).toEqual({});
  });

  it('expires a cookie', () => {
    const cleared = clearCookie('__Host-sid');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
  });
});

describe('CSRF', () => {
  const guard = csrfGuard({ secret: SECRET });

  const post = (headers: Record<string, string> = {}) =>
    new Request('https://app.example.com/transfer', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', ...headers },
    });

  it('does not apply to safe methods', async () => {
    expect(requiresCsrfCheck('GET')).toBe(false);
    const verdict = await guard.verify(new Request('https://app.example.com/'), 'session-1');
    expect(verdict.ok).toBe(true);
  });

  it('accepts a token bound to the same session', async () => {
    const token = await guard.issue('session-1');
    expect(await guard.verify(post({ 'x-csrf-token': token }), 'session-1')).toEqual({ ok: true });
  });

  // The point of binding the session id into the MAC: an attacker who can set
  // cookies on a sibling subdomain can plant a matching cookie/header pair, but
  // cannot produce one that validates against the victim's session.
  it('rejects a token minted for a different session', async () => {
    const token = await guard.issue('session-1');
    expect(await guard.verify(post({ 'x-csrf-token': token }), 'session-2')).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('rejects a missing or malformed token', async () => {
    expect(await guard.verify(post(), 'session-1')).toEqual({ ok: false, reason: 'missing_token' });
    expect(await guard.verify(post({ 'x-csrf-token': 'nodot' }), 'session-1')).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    expect(
      await guard.verify(post({ 'x-csrf-token': 'nonce.not+base64url' }), 'session-1'),
    ).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a cross-site request before checking the token', async () => {
    const token = await guard.issue('session-1');
    const request = new Request('https://app.example.com/transfer', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'x-csrf-token': token },
    });
    expect(await guard.verify(request, 'session-1')).toEqual({ ok: false, reason: 'cross_origin' });
  });

  describe('origin checking', () => {
    const build = (headers: Record<string, string>) =>
      new Request('https://app.example.com/x', { method: 'POST', headers });

    it('trusts Sec-Fetch-Site when present', () => {
      expect(checkRequestOrigin(build({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
      expect(checkRequestOrigin(build({ 'sec-fetch-site': 'none' }))).toBe(true);
      expect(checkRequestOrigin(build({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
      // `same-site` still permits a sibling subdomain — exactly the attacker
      // position the session-bound token defends against.
      expect(checkRequestOrigin(build({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    });

    it('falls back to Origin', () => {
      expect(checkRequestOrigin(build({ origin: 'https://app.example.com' }))).toBe(true);
      expect(checkRequestOrigin(build({ origin: 'https://evil.example.com' }))).toBe(false);
      expect(
        checkRequestOrigin(build({ origin: 'https://other.com' }), {
          allowedOrigins: ['https://other.com'],
        }),
      ).toBe(true);
    });

    it('allows a request with neither header unless configured otherwise', () => {
      // Non-browser clients legitimately send neither; the token check still applies.
      expect(checkRequestOrigin(build({}))).toBe(true);
      expect(checkRequestOrigin(build({}), { requireOriginHeader: true })).toBe(false);
    });
  });
});

describe('sessionManager', () => {
  const build = (now: () => number = () => 1_000) =>
    sessionManager({ store: memorySessionStore({ now }), now });

  it('stores the session id hashed, never the token', async () => {
    const store = memorySessionStore();
    const sessions = sessionManager({ store });
    const issued = await sessions.create({ subject: 'u1' });

    expect(issued.record.id).not.toBe(issued.token);
    expect(await store.get(issued.token)).toBeNull();
    expect(await store.get(await sessions.keyOf(issued.token))).not.toBeNull();
  });

  it('resolves an active session', async () => {
    const sessions = build();
    const issued = await sessions.create({ subject: 'u1', amr: ['pwd'] });
    const lookup = await sessions.resolve(issued.token);
    expect(lookup.state).toBe('active');
    if (lookup.state === 'active') {
      expect(lookup.principal.sub).toBe('u1');
      expect(lookup.principal.method).toBe('session');
      expect(lookup.principal.amr).toEqual(['pwd']);
    }
  });

  it('enforces the absolute timeout', async () => {
    let clock = 1_000;
    const sessions = sessionManager({
      store: memorySessionStore({ now: () => clock }),
      policy: { absoluteTimeoutSeconds: 60, inactivityTimeoutSeconds: 0 },
      now: () => clock,
    });
    const issued = await sessions.create({ subject: 'u1' });
    clock += 61;
    expect(await sessions.resolve(issued.token)).toEqual({ state: 'expired', reason: 'absolute' });
  });

  it('enforces the inactivity timeout independently', async () => {
    let clock = 1_000;
    const sessions = sessionManager({
      store: memorySessionStore({ now: () => clock }),
      policy: {
        absoluteTimeoutSeconds: 86_400,
        inactivityTimeoutSeconds: 60,
        touchIntervalSeconds: 1,
      },
      now: () => clock,
    });
    const issued = await sessions.create({ subject: 'u1' });

    clock += 30;
    expect((await sessions.resolve(issued.token)).state).toBe('active');
    clock += 30; // touched at +30, so still inside the window
    expect((await sessions.resolve(issued.token)).state).toBe('active');
    clock += 61;
    expect(await sessions.resolve(issued.token)).toEqual({
      state: 'expired',
      reason: 'inactivity',
    });
  });

  // Session fixation: an id the client held before authenticating must not
  // survive it.
  it('regenerates the id and invalidates the old one', async () => {
    const sessions = build();
    const first = await sessions.create({ subject: 'u1' });
    const second = await sessions.regenerate(first.token);

    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first.token);
    expect((await sessions.resolve(first.token)).state).toBe('not-found');
    expect((await sessions.resolve(second!.token)).state).toBe('active');
  });

  it('preserves authTime across regeneration', async () => {
    let clock = 1_000;
    const sessions = sessionManager({
      store: memorySessionStore({ now: () => clock }),
      now: () => clock,
    });
    const first = await sessions.create({ subject: 'u1' });
    clock += 500;
    const second = await sessions.regenerate(first.token);
    expect(second!.record.authTime).toBe(first.record.authTime);
  });

  it('revokes one session and all sessions for a subject', async () => {
    const sessions = build();
    const a = await sessions.create({ subject: 'u1' });
    const b = await sessions.create({ subject: 'u1' });
    const other = await sessions.create({ subject: 'u2' });

    expect(await sessions.revoke(a.token)).toBe(true);
    expect((await sessions.resolve(a.token)).state).toBe('not-found');
    expect((await sessions.resolve(b.token)).state).toBe('active');

    expect(await sessions.revokeAllForSubject('u1')).toBe(1);
    expect((await sessions.resolve(b.token)).state).toBe('not-found');
    expect((await sessions.resolve(other.token)).state).toBe('active');
  });

  it('defaults to the AAL2 policy', () => {
    expect(build().policy).toEqual(AAL2_POLICY);
    expect(() => resolveSessionPolicy({ absoluteTimeoutSeconds: 0 })).toThrow(RangeError);
  });
});

describe('passwordService', () => {
  const build = (policy = {}) => {
    const users = memoryUserStore();
    const credentials = memoryCredentialStore();
    const throttle = memoryLoginThrottle({ maxAttempts: 3 });
    return {
      users,
      credentials,
      throttle,
      passwords: passwordService({
        users,
        credentials,
        hasher: pbkdf2Hasher({ iterations: 1_000 }),
        throttle,
        policy,
      }),
    };
  };

  it('creates a user and logs them in', async () => {
    const { passwords } = build();
    await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });
    const { principal } = await passwords.login('ada@example.com', 'correct horse battery');
    expect(principal.method).toBe('password');
    expect(principal.amr).toEqual(['pwd']);
  });

  it('generates an opaque WebAuthn handle that is not the identifier', async () => {
    const { passwords, users } = build();
    const user = await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });
    const stored = await users.findById(user.id);
    expect(stored!.webauthnUserHandle).toBeDefined();
    expect(stored!.webauthnUserHandle).not.toContain('ada');
  });

  // A login endpoint that distinguishes "no such user" from "wrong password" is
  // a user-enumeration oracle.
  it('reports the same error whether the user or the password is wrong', async () => {
    const { passwords } = build();
    await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });

    const missing = await passwords.login('nobody@example.com', 'x'.repeat(12)).catch((e) => e);
    const wrong = await passwords.login('ada@example.com', 'x'.repeat(12)).catch((e) => e);

    expect(missing).toBeInstanceOf(AuthError);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(missing.code).toBe('invalid_credentials');
    expect(wrong.code).toBe('invalid_credentials');
    expect(missing.publicMessage).toBe(wrong.publicMessage);
    // The distinguishing detail exists, but only in the log-facing message.
    expect(missing.message).not.toBe(wrong.message);
  });

  it('throttles repeated failures', async () => {
    const { passwords } = build();
    await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      await passwords.login('ada@example.com', 'wrong password!').catch(() => undefined);
    }
    const throttled = await passwords
      .login('ada@example.com', 'correct horse battery')
      .catch((e) => e);
    expect(throttled.code).toBe('throttled');
    expect(throttled.status).toBe(429);
  });

  it('clears the throttle after a successful login', async () => {
    const { passwords } = build();
    await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });
    await passwords.login('ada@example.com', 'wrong password!').catch(() => undefined);
    await passwords.login('ada@example.com', 'correct horse battery');
    await passwords.login('ada@example.com', 'wrong password!').catch(() => undefined);
    await expect(
      passwords.login('ada@example.com', 'correct horse battery'),
    ).resolves.toBeDefined();
  });

  // NIST SP 800-63B: minimum 8, verifiers must accept at least 64, no
  // composition rules, no rotation.
  it('applies the NIST policy', async () => {
    const { passwords } = build();
    await expect(passwords.validate('short')).rejects.toThrow(/at least 8 characters/);
    await expect(passwords.validate('a'.repeat(64))).resolves.toBeUndefined();
    await expect(passwords.validate('   spaces are fine   ')).resolves.toBeUndefined();
    // No composition rule to violate.
    await expect(passwords.validate('aaaaaaaaaaaa')).resolves.toBeUndefined();
  });

  it('refuses a maxLength below the 64-character floor', () => {
    expect(() =>
      passwordService({
        users: memoryUserStore(),
        credentials: memoryCredentialStore(),
        hasher: pbkdf2Hasher({ iterations: 1 }),
        policy: { maxLength: 20 },
      }),
    ).toThrow(/at least 64/);
  });

  it('supports a breach-list check', async () => {
    const { passwords } = build({ breachedCheck: (pw: string) => pw === 'password123456' });
    await expect(passwords.validate('password123456')).rejects.toThrow(/known data breach/);
    await expect(passwords.validate('a-fine-passphrase')).resolves.toBeUndefined();
  });

  it('rejects a duplicate identifier without confirming it exists', async () => {
    const { passwords } = build();
    await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });
    const error = await passwords
      .createUser({ identifier: 'ada@example.com', password: 'another passphrase' })
      .catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.publicMessage).toBe('Unable to complete registration');
  });

  it('transparently upgrades a hash with weaker parameters', async () => {
    const users = memoryUserStore();
    const credentials = memoryCredentialStore();
    const weak = passwordService({
      users,
      credentials,
      hasher: pbkdf2Hasher({ iterations: 1_000 }),
    });
    await weak.createUser({ identifier: 'ada@example.com', password: 'correct horse battery' });
    const before = (await credentials.findPassword(
      (await users.findByIdentifier('ada@example.com'))!.id,
    ))!;
    expect(before.hash).toContain('i=1000');

    const strong = passwordService({
      users,
      credentials,
      hasher: pbkdf2Hasher({ iterations: 5_000 }),
    });
    await strong.login('ada@example.com', 'correct horse battery');
    const after = (await credentials.findPassword(
      (await users.findByIdentifier('ada@example.com'))!.id,
    ))!;
    expect(after.hash).toContain('i=5000');
  });

  it('changes a password only when the current one is presented', async () => {
    const { passwords } = build();
    const user = await passwords.createUser({
      identifier: 'ada@example.com',
      password: 'correct horse battery',
    });
    await expect(passwords.changePassword(user.id, 'wrong', 'new passphrase here')).rejects.toThrow(
      AuthError,
    );
    await passwords.changePassword(user.id, 'correct horse battery', 'new passphrase here');
    await expect(passwords.login('ada@example.com', 'new passphrase here')).resolves.toBeDefined();
  });
});
