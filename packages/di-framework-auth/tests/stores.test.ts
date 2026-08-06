import { describe, expect, it, spyOn } from 'bun:test';
import { InMemoryRepository } from '@di-framework/repo';
import {
  inMemoryAuthStores,
  memoryCredentialStore,
  memoryKeyStore,
  memoryLoginThrottle,
  memoryRefreshTokenStore,
  memorySessionStore,
  memoryStateStore,
  memoryUserStore,
} from '../src/providers/memory.ts';
import {
  type AtomicOps,
  repoCredentialStore,
  repoKeyStore,
  repoRefreshTokenStore,
  repoSessionStore,
  repoStateStore,
  repoUserStore,
  type StorageAdapterLike,
} from '../src/providers/repo.ts';
import type {
  ApiKeyCredential,
  PasswordCredential,
  RefreshTokenRecord,
  SessionRecord,
  SessionStore,
  SigningKeyRecord,
  StateStore,
  UserRecord,
  UserStore,
  WebAuthnCredential,
} from '../src/providers/types.ts';

/**
 * One conformance suite, run against both the in-memory stores and the
 * `@di-framework/repo` bridge. A store that only passes for one backend is a
 * store whose contract is not actually written down.
 */

/** A minimal StorageAdapter over a Map, standing in for a real backend. */
function mapAdapter<E extends { id: string }>(): StorageAdapterLike<E> & { data: Map<string, E> } {
  const data = new Map<string, E>();
  return {
    data,
    async findById(id) {
      return data.get(id) ?? null;
    },
    async save(entity) {
      data.set(entity.id, entity);
      return entity;
    },
    async delete(id) {
      return data.delete(id);
    },
    async findPaginated({ page = 1, size = 50, filter = {} }) {
      const items = [...data.values()].filter((entity) =>
        Object.entries(filter).every(
          ([key, value]) => (entity as unknown as Record<string, unknown>)[key] === value,
        ),
      );
      const start = (page - 1) * size;
      return {
        items: items.slice(start, start + size),
        total: items.length,
        page,
        size,
        pages: Math.max(1, Math.ceil(items.length / size)),
      };
    },
  };
}

function atomicOps<E extends { id: string }>(
  adapter: ReturnType<typeof mapAdapter<E>>,
): AtomicOps<E> {
  return {
    // Single-threaded and without an await between read and write, so this is
    // genuinely indivisible — the property a real backend must reproduce with a
    // conditional update.
    async compareAndSwap(id, mutate) {
      const next = mutate(adapter.data.get(id) ?? null);
      if (!next) return false;
      adapter.data.set(id, next);
      return true;
    },
    async takeOnce(id) {
      const found = adapter.data.get(id) ?? null;
      if (found) adapter.data.delete(id);
      return found;
    },
  };
}

const userFixture = (id: string, identifier: string): UserRecord => ({
  id,
  identifier,
  createdAt: 0,
});

function runUserStoreSuite(name: string, build: () => UserStore) {
  describe(`UserStore conformance (${name})`, () => {
    it('creates and reads back by id and identifier', async () => {
      const store = build();
      await store.create(userFixture('u1', 'Ada@Example.com'));
      expect((await store.findById('u1'))?.identifier).toBe('Ada@Example.com');
      // Identifier lookup is case-insensitive, or the same person can register twice.
      expect((await store.findByIdentifier('ada@example.com'))?.id).toBe('u1');
      expect(await store.findByIdentifier('nobody@example.com')).toBeNull();
    });

    it('updates and deletes', async () => {
      const store = build();
      await store.create(userFixture('u1', 'ada@example.com'));
      expect((await store.update('u1', { displayName: 'Ada' }))?.displayName).toBe('Ada');
      expect(await store.update('missing', {})).toBeNull();
      expect(await store.delete('u1')).toBe(true);
      expect(await store.findById('u1')).toBeNull();
    });

    it('finds by WebAuthn handle', async () => {
      const store = build();
      await store.create({
        ...userFixture('u1', 'ada@example.com'),
        webauthnUserHandle: 'handle-1',
      });
      expect((await store.findByWebAuthnHandle('handle-1'))?.id).toBe('u1');
      expect(await store.findByWebAuthnHandle('nope')).toBeNull();
    });
  });
}

const sessionFixture = (id: string, subject: string): SessionRecord => ({
  id,
  subject,
  createdAt: 0,
  authTime: 0,
  lastSeenAt: 0,
  absoluteExpiresAt: 10_000,
});

function runSessionStoreSuite(name: string, build: () => SessionStore) {
  describe(`SessionStore conformance (${name})`, () => {
    it('creates, reads, touches, and deletes', async () => {
      const store = build();
      await store.create(sessionFixture('s1', 'u1'));
      expect((await store.get('s1'))?.subject).toBe('u1');

      await store.touch('s1', 500);
      expect((await store.get('s1'))?.lastSeenAt).toBe(500);

      expect(await store.delete('s1')).toBe(true);
      expect(await store.get('s1')).toBeNull();
    });

    // Stores are persistence, not policy: SessionManager owns expiry, and a
    // store that filtered here would make an absolute expiry look like a session
    // that never existed.
    it('returns an expired record rather than filtering it', async () => {
      const store = build();
      await store.create({ ...sessionFixture('s1', 'u1'), absoluteExpiresAt: 1 });
      expect(await store.get('s1')).not.toBeNull();
    });

    it('deletes every session for a subject', async () => {
      const store = build();
      await store.create(sessionFixture('s1', 'u1'));
      await store.create(sessionFixture('s2', 'u1'));
      await store.create(sessionFixture('s3', 'u2'));

      expect(await store.deleteBySubject('u1')).toBe(2);
      expect(await store.get('s1')).toBeNull();
      expect(await store.get('s3')).not.toBeNull();
    });
  });
}

function runStateStoreSuite(name: string, build: () => StateStore) {
  describe(`StateStore conformance (${name})`, () => {
    it('consumes an entry exactly once', async () => {
      const store = build();
      await store.put({
        purpose: 'oauth-state',
        key: 'k1',
        data: { nonce: 'n' },
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });

      expect((await store.consume('oauth-state', 'k1'))?.data).toEqual({ nonce: 'n' });
      // Single use is the whole point: OAuth state and WebAuthn challenges.
      expect(await store.consume('oauth-state', 'k1')).toBeNull();
    });

    it('namespaces by purpose', async () => {
      const store = build();
      await store.put({
        purpose: 'oauth-state',
        key: 'shared',
        data: {},
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
      expect(await store.consume('webauthn-registration', 'shared')).toBeNull();
      expect(await store.consume('oauth-state', 'shared')).not.toBeNull();
    });

    it('refuses an expired entry', async () => {
      const store = build();
      await store.put({ purpose: 'oauth-state', key: 'old', data: {}, expiresAt: 1 });
      expect(await store.consume('oauth-state', 'old')).toBeNull();
    });
  });
}

runUserStoreSuite('memory', () => inMemoryAuthStores().users);
runUserStoreSuite('repo', () => repoUserStore({ adapter: mapAdapter<UserRecord>() }));

runSessionStoreSuite('memory', () => inMemoryAuthStores().sessions);
runSessionStoreSuite('repo', () => repoSessionStore({ adapter: mapAdapter<SessionRecord>() }));

runStateStoreSuite('memory', () => memoryStateStore());
runStateStoreSuite('repo', () => {
  const adapter = mapAdapter<{ id: string } & Parameters<StateStore['put']>[0]>();
  return repoStateStore({ adapter, atomic: atomicOps(adapter) });
});

describe('repo bridge refuses to degrade silently', () => {
  // StorageAdapter has no conditional write. Shipping a replay defence that does
  // nothing would be worse than refusing to construct.
  it('requires an atomic takeOnce for the state store', () => {
    const adapter = mapAdapter<{ id: string } & Parameters<StateStore['put']>[0]>();
    expect(() => repoStateStore({ adapter, atomic: { compareAndSwap: async () => true } })).toThrow(
      /requires `atomic.takeOnce`/,
    );
  });

  it('requires an atomic compareAndSwap for refresh tokens', () => {
    const adapter = mapAdapter<RefreshTokenRecord>();
    expect(() =>
      repoRefreshTokenStore({ adapter, atomic: {} as AtomicOps<RefreshTokenRecord> }),
    ).toThrow(/requires `atomic.compareAndSwap`/);
  });

  it('detects a concurrent rotation as reuse', async () => {
    const adapter = mapAdapter<RefreshTokenRecord>();
    const store = repoRefreshTokenStore({ adapter, atomic: atomicOps(adapter) });
    const now = Math.floor(Date.now() / 1000);
    const record: RefreshTokenRecord = {
      id: 'r1',
      subject: 'u1',
      familyId: 'f1',
      createdAt: now,
      expiresAt: now + 600,
      authTime: now,
    };
    await store.issue(record);

    const next = { ...record, id: 'r2' };
    expect((await store.rotate('r1', next, now)).outcome).toBe('rotated');
    expect((await store.rotate('r1', { ...record, id: 'r3' }, now)).outcome).toBe('reused');
  });
});

describe('repo bridge against InMemoryRepository', () => {
  it('works with the adapter shipped by @di-framework/repo', async () => {
    // Proves the bridge targets the real protocol, not just a hand-rolled mock.
    const repository = new InMemoryRepository<UserRecord, string>();
    const store = repoUserStore({
      adapter: repository as unknown as StorageAdapterLike<UserRecord>,
    });

    await store.create(userFixture('u1', 'ada@example.com'));
    expect((await store.findById('u1'))?.identifier).toBe('ada@example.com');
    expect(await store.delete('u1')).toBe(true);
  });
});

describe('login throttle', () => {
  // NIST SP 800-63B §5.2.2 requires throttling; PBKDF2 without it is a
  // denial-of-service vector as well as a guessing one.
  it('locks a bucket after the configured failures', async () => {
    const throttle = memoryLoginThrottle({ maxAttempts: 3, windowSeconds: 60 });

    expect((await throttle.check('u1')).allowed).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) await throttle.fail('u1');

    const decision = await throttle.check('u1');
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfter).toBeGreaterThan(0);

    // Buckets are per key.
    expect((await throttle.check('u2')).allowed).toBe(true);
  });

  it('resets on success and after the window', async () => {
    let clock = 1_000;
    const throttle = memoryLoginThrottle({ maxAttempts: 1, windowSeconds: 60, now: () => clock });

    await throttle.fail('u1');
    expect((await throttle.check('u1')).allowed).toBe(false);

    await throttle.reset('u1');
    expect((await throttle.check('u1')).allowed).toBe(true);

    await throttle.fail('u1');
    clock += 61;
    expect((await throttle.check('u1')).allowed).toBe(true);
  });
});

describe('field mapping (repo bridge)', () => {
  it('maps and reverse-maps fields when a custom schema is supplied', async () => {
    const adapter = mapAdapter<{ id: string; login: string; login_key?: string }>();
    const store = repoUserStore({
      adapter: adapter as unknown as StorageAdapterLike<UserRecord>,
      fields: { identifier: 'login', identifierKey: 'login_key' },
    });

    const created = await store.create(userFixture('u1', 'Ada@Example.com'));
    expect(created.identifier).toBe('Ada@Example.com');
    // Stored under the mapped field name, not the auth package's own name.
    expect(adapter.data.get('u1')).toMatchObject({ login: 'Ada@Example.com' });
    expect((adapter.data.get('u1') as Record<string, unknown>)['identifier']).toBeUndefined();

    expect((await store.findByIdentifier('ada@example.com'))?.id).toBe('u1');
  });

  it('is the identity mapping when fields is omitted or maps a field to itself', async () => {
    const adapter = mapAdapter<UserRecord>();
    const store = repoUserStore({
      adapter,
      fields: { identifier: 'identifier' },
    });
    await store.create(userFixture('u1', 'ada@example.com'));
    expect((await store.findById('u1'))?.identifier).toBe('ada@example.com');
  });

  it('is also the identity mapping when fields has no string-valued entries', async () => {
    const adapter = mapAdapter<UserRecord>();
    const store = repoUserStore({
      adapter,
      // No usable renames — every entry is filtered out, exercising the
      // "no-op" branch of both the mapper and its reverse.
      fields: {},
    });
    await store.create(userFixture('u1', 'ada@example.com'));
    expect((await store.findById('u1'))?.identifier).toBe('ada@example.com');
  });
});

describe('listAll pagination', () => {
  it('walks every page until the adapter reports no more', async () => {
    const adapter = mapAdapter<SessionRecord>();
    const store = repoSessionStore({ adapter, pageSize: 1 });
    await store.create(sessionFixture('s1', 'shared'));
    await store.create(sessionFixture('s2', 'shared'));
    await store.create(sessionFixture('s3', 'shared'));

    expect(await store.deleteBySubject('shared')).toBe(3);
    expect(await store.get('s1')).toBeNull();
    expect(await store.get('s2')).toBeNull();
    expect(await store.get('s3')).toBeNull();
  });
});

describe('repoCredentialStore', () => {
  const build = () => {
    const passwords = mapAdapter<PasswordCredential>();
    const webauthn = mapAdapter<WebAuthnCredential>();
    const apiKeys = mapAdapter<ApiKeyCredential>();
    const atomic: AtomicOps<WebAuthnCredential> = {
      async compareAndSwap(id, mutate) {
        const next = mutate(webauthn.data.get(id) ?? null);
        if (!next) return false;
        webauthn.data.set(id, next);
        return true;
      },
    };
    return {
      passwords,
      webauthn,
      apiKeys,
      store: repoCredentialStore({ passwords, webauthn, apiKeys, atomic }),
    };
  };

  it('covers the full password credential lifecycle', async () => {
    const { store } = build();
    expect(await store.findPassword('u1')).toBeNull();
    const saved = await store.savePassword({
      kind: 'password',
      id: 'ignored',
      userId: 'u1',
      hash: 'h',
      createdAt: 0,
      updatedAt: 0,
    });
    expect(saved.userId).toBe('u1');
    expect((await store.findPassword('u1'))?.hash).toBe('h');
    expect(await store.deletePassword('u1')).toBe(true);
    expect(await store.findPassword('u1')).toBeNull();
  });

  it('covers the full WebAuthn credential lifecycle, including a failed sign-count CAS', async () => {
    const { store } = build();
    const credential: WebAuthnCredential = {
      kind: 'webauthn',
      id: 'cred-1',
      userId: 'u1',
      publicKeyCose: 'AQ',
      algorithm: -7,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      uvInitialized: true,
      createdAt: 0,
      version: 1,
    };
    await store.saveWebAuthn(credential);
    expect((await store.findWebAuthn('cred-1'))?.id).toBe('cred-1');
    expect(await store.listWebAuthn('u1')).toHaveLength(1);
    expect(await store.listWebAuthn('u2')).toEqual([]);

    expect(await store.updateSignCount('cred-1', 5, 999, 10)).toBe(false);
    expect(await store.updateSignCount('cred-1', 5, 1, 10, true)).toBe(true);
    expect((await store.findWebAuthn('cred-1'))?.signCount).toBe(5);

    expect(await store.deleteWebAuthn('cred-1')).toBe(true);
    expect(await store.findWebAuthn('cred-1')).toBeNull();
  });

  it('covers the full API-key credential lifecycle', async () => {
    const { store } = build();
    const credential: ApiKeyCredential = {
      kind: 'api-key',
      id: 'hashed',
      userId: 'u1',
      createdAt: 0,
    };
    await store.saveApiKey(credential);
    expect((await store.findApiKey('hashed'))?.userId).toBe('u1');
    expect(await store.listApiKeys('u1')).toHaveLength(1);
    expect(await store.listApiKeys('u2')).toEqual([]);
    expect(await store.deleteApiKey('hashed')).toBe(true);
    expect(await store.findApiKey('hashed')).toBeNull();
  });
});

describe('repoRefreshTokenStore direct operations', () => {
  const record = (id: string, familyId: string, subject: string) => ({
    id,
    subject,
    familyId,
    createdAt: 0,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    authTime: 0,
  });

  it('revokes an entire family across pages', async () => {
    const adapter = mapAdapter<RefreshTokenRecord>();
    const store = repoRefreshTokenStore({ adapter, atomic: atomicOps(adapter), pageSize: 1 });
    await store.issue(record('r1', 'f1', 'u1'));
    await store.issue(record('r2', 'f1', 'u1'));
    await store.issue(record('r3', 'f2', 'u1'));

    expect(await store.revokeFamily('f1')).toBe(2);
    expect(await store.find('r1')).toBeNull();
    expect(await store.find('r3')).not.toBeNull();
  });

  it('revokes every token for a subject', async () => {
    const adapter = mapAdapter<RefreshTokenRecord>();
    const store = repoRefreshTokenStore({ adapter, atomic: atomicOps(adapter) });
    await store.issue(record('r1', 'f1', 'u1'));
    await store.issue(record('r2', 'f2', 'u1'));
    await store.issue(record('r3', 'f3', 'u2'));

    expect(await store.revokeBySubject('u1')).toBe(2);
    expect(await store.find('r3')).not.toBeNull();
  });

  it('reports not-found and expired outcomes', async () => {
    const adapter = mapAdapter<RefreshTokenRecord>();
    const store = repoRefreshTokenStore({ adapter, atomic: atomicOps(adapter) });
    expect((await store.rotate('ghost', record('r2', 'f1', 'u1'), 0)).outcome).toBe('not-found');

    const expired = { ...record('r1', 'f1', 'u1'), expiresAt: 1 };
    await store.issue(expired);
    expect((await store.rotate('r1', record('r2', 'f1', 'u1'), 100)).outcome).toBe('expired');
  });
});

describe('repoKeyStore', () => {
  const key = (kid: string): SigningKeyRecord => ({
    kid,
    algorithm: 'ES256',
    privateJwk: {},
    publicJwk: {},
    createdAt: 0,
  });

  it('tracks a single current key, demoting the previous one', async () => {
    const adapter = mapAdapter<{ id: string } & SigningKeyRecord & { current?: boolean }>();
    const store = repoKeyStore({ adapter });

    await expect(store.current()).rejects.toThrow(/No current signing key/);

    await store.save(key('k1'));
    expect((await store.current()).kid).toBe('k1');

    await store.save(key('k2'));
    expect((await store.current()).kid).toBe('k2');
    expect((await adapter.findById('k1'))?.['current']).toBe(false);

    expect((await store.find('k1'))?.kid).toBe('k1');
    expect(await store.find('ghost')).toBeNull();

    expect(await store.delete('k1')).toBe(true);
  });

  it('filters expired keys out of all(), current first', async () => {
    const adapter = mapAdapter<{ id: string } & SigningKeyRecord & { current?: boolean }>();
    const store = repoKeyStore({ adapter, pageSize: 1 });

    await store.save({ ...key('expired'), notAfter: 5, expiresAt: 5 });
    // At least two live-but-not-current keys, so the sort comparator's
    // `createdAt` tie-break actually runs (a single surviving key never
    // invokes the comparator at all).
    await store.save({ ...key('retired-1'), notAfter: 1, createdAt: 10 });
    await store.save({ ...key('retired-2'), notAfter: 1, createdAt: 20 });
    await store.save(key('new'));

    const all = await store.all();
    const kids = all.map((record) => record.kid);
    expect(kids).not.toContain('expired');
    expect(kids[0]).toBe('new');
    expect(kids).toContain('retired-1');
    expect(kids).toContain('retired-2');
    // Among the non-current keys, newest createdAt sorts first.
    expect(kids.indexOf('retired-2')).toBeLessThan(kids.indexOf('retired-1'));
  });

  it('a key past notAfter does not become current', async () => {
    const adapter = mapAdapter<{ id: string } & SigningKeyRecord & { current?: boolean }>();
    const store = repoKeyStore({ adapter });
    await store.save(key('k1'));
    await store.save({ ...key('k2'), notAfter: 1 });
    expect((await store.current()).kid).toBe('k1');
  });
});

describe('memoryUserStore direct operations', () => {
  it('refuses a duplicate id or identifier', async () => {
    const users = memoryUserStore();
    await users.create(userFixture('u1', 'ada@example.com'));
    await expect(users.create(userFixture('u1', 'someone-else@example.com'))).rejects.toThrow(
      /already exists/,
    );
    await expect(users.create(userFixture('u2', 'Ada@Example.com'))).rejects.toThrow(
      /already registered/,
    );
  });

  it('re-indexes the identifier when it changes, and drops WebAuthn handle index on delete', async () => {
    const users = memoryUserStore();
    await users.create({ ...userFixture('u1', 'old@example.com'), webauthnUserHandle: 'h1' });

    await users.update('u1', { identifier: 'new@example.com' });
    expect(await users.findByIdentifier('old@example.com')).toBeNull();
    expect((await users.findByIdentifier('new@example.com'))?.id).toBe('u1');

    await users.delete('u1');
    expect(await users.findByWebAuthnHandle('h1')).toBeNull();
  });
});

describe('memorySessionStore direct operations', () => {
  it('purges only sessions past their absolute expiry, from every subject bucket', async () => {
    const sessions = memorySessionStore();
    await sessions.create(sessionFixture('s1', 'u1'));
    await sessions.create({ ...sessionFixture('s2', 'u2'), absoluteExpiresAt: 5 });

    expect(await sessions.purgeExpired!(10)).toBe(1);
    expect(await sessions.get('s1')).not.toBeNull();
    expect(await sessions.get('s2')).toBeNull();
    // Purging again removes nothing further.
    expect(await sessions.purgeExpired!(10)).toBe(0);
  });

  it('touch() is a no-op for a session that no longer exists', async () => {
    const sessions = memorySessionStore();
    await expect(sessions.touch('nope', 100)).resolves.toBeUndefined();
  });

  it('deleteBySubject() returns 0 for an unknown subject', async () => {
    const sessions = memorySessionStore();
    expect(await sessions.deleteBySubject('ghost')).toBe(0);
  });
});

describe('memoryCredentialStore direct operations', () => {
  it('covers the full password credential lifecycle', async () => {
    const credentials = memoryCredentialStore();
    expect(await credentials.findPassword('u1')).toBeNull();
    const saved = await credentials.savePassword({
      kind: 'password',
      id: 'c1',
      userId: 'u1',
      hash: 'hash',
      createdAt: 0,
      updatedAt: 0,
    });
    expect(await credentials.findPassword('u1')).toEqual(saved);
    expect(await credentials.deletePassword('u1')).toBe(true);
    expect(await credentials.deletePassword('u1')).toBe(false);
  });

  it('covers the full WebAuthn credential lifecycle, including a failed sign-count CAS', async () => {
    const credentials = memoryCredentialStore();
    const credential = await credentials.saveWebAuthn({
      kind: 'webauthn',
      id: 'cred-1',
      userId: 'u1',
      publicKeyCose: 'AQ',
      algorithm: -7,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      uvInitialized: true,
      createdAt: 0,
      version: 1,
    });
    expect(await credentials.findWebAuthn('cred-1')).toEqual(credential);
    expect(await credentials.listWebAuthn('u1')).toEqual([credential]);
    expect(await credentials.listWebAuthn('u2')).toEqual([]);

    // Wrong expected version: the CAS must refuse rather than overwrite.
    expect(await credentials.updateSignCount('cred-1', 5, 999, 10)).toBe(false);
    expect(await credentials.updateSignCount('cred-1', 5, 1, 10, true)).toBe(true);
    const updated = await credentials.findWebAuthn('cred-1');
    expect(updated?.signCount).toBe(5);
    expect(updated?.version).toBe(2);
    expect(updated?.backupState).toBe(true);

    expect(await credentials.deleteWebAuthn('cred-1')).toBe(true);
    expect(await credentials.findWebAuthn('cred-1')).toBeNull();
  });

  it('covers the full API-key credential lifecycle', async () => {
    const credentials = memoryCredentialStore();
    const credential = await credentials.saveApiKey({
      kind: 'api-key',
      id: 'hashed-key',
      userId: 'u1',
      createdAt: 0,
    });
    expect(await credentials.findApiKey('hashed-key')).toEqual(credential);
    expect(await credentials.listApiKeys('u1')).toEqual([credential]);
    expect(await credentials.listApiKeys('u2')).toEqual([]);
    expect(await credentials.deleteApiKey('hashed-key')).toBe(true);
    expect(await credentials.findApiKey('hashed-key')).toBeNull();
  });
});

describe('memoryStateStore direct operations', () => {
  it('purges only entries past their expiry', async () => {
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const state = memoryStateStore();
    await state.put({ purpose: 'oauth-state', key: 'k1', data: {}, expiresAt: 5 });
    await state.put({ purpose: 'oauth-state', key: 'k2', data: {}, expiresAt: future });
    expect(await state.purgeExpired!(10)).toBe(1);
    expect(await state.consume('oauth-state', 'k2')).not.toBeNull();
  });
});

describe('memoryRefreshTokenStore direct operations', () => {
  const record = (id: string, familyId: string, subject: string, expiresAt = 500) => ({
    id,
    subject,
    familyId,
    createdAt: 0,
    expiresAt,
    authTime: 0,
  });

  it('revokes an entire family', async () => {
    const store = memoryRefreshTokenStore();
    await store.issue(record('r1', 'f1', 'u1'));
    await store.issue(record('r2', 'f1', 'u1'));
    await store.issue(record('r3', 'f2', 'u1'));

    expect(await store.revokeFamily('f1')).toBe(2);
    expect(await store.find('r1')).toBeNull();
    expect(await store.find('r3')).not.toBeNull();
    // Revoking an unknown family is a no-op.
    expect(await store.revokeFamily('ghost')).toBe(0);
  });

  it('revokes every token for a subject', async () => {
    const store = memoryRefreshTokenStore();
    await store.issue(record('r1', 'f1', 'u1'));
    await store.issue(record('r2', 'f2', 'u1'));
    await store.issue(record('r3', 'f3', 'u2'));

    expect(await store.revokeBySubject('u1')).toBe(2);
    expect(await store.find('r3')).not.toBeNull();
    expect(await store.revokeBySubject('ghost')).toBe(0);
  });

  it('purges only tokens past their expiry', async () => {
    const store = memoryRefreshTokenStore();
    await store.issue(record('r1', 'f1', 'u1', 5));
    await store.issue(record('r2', 'f2', 'u1', 500));
    expect(await store.purgeExpired!(10)).toBe(1);
    expect(await store.find('r1')).toBeNull();
    expect(await store.find('r2')).not.toBeNull();
  });
});

describe('memoryKeyStore direct operations', () => {
  const signingKey = (kid: string) => ({
    kid,
    algorithm: 'ES256' as const,
    privateJwk: {},
    publicJwk: {},
    createdAt: 0,
  });

  it('clears the current pointer when the current key is deleted', async () => {
    const keys = memoryKeyStore();
    await keys.save(signingKey('k1'));
    expect((await keys.current()).kid).toBe('k1');

    expect(await keys.delete('k1')).toBe(true);
    await expect(keys.current()).rejects.toThrow(/No signing key registered/);
    // Deleting an unknown kid is simply false, and does not disturb `current`.
    await keys.save(signingKey('k2'));
    expect(await keys.delete('ghost')).toBe(false);
    expect((await keys.current()).kid).toBe('k2');
  });

  it('filters out expired keys from all(), preferring the current key first', async () => {
    const keys = memoryKeyStore();
    await keys.save({ ...signingKey('old'), notAfter: 5, expiresAt: 5 });
    await keys.save(signingKey('new'));
    const all = await keys.all();
    expect(all.map((key) => key.kid)).not.toContain('old');
    expect(all[0]?.kid).toBe('new');
  });
});

describe('inMemoryAuthStores() production warning', () => {
  it('warns exactly once when NODE_ENV=production and silent is not set', () => {
    const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
    const original = proc?.env.NODE_ENV;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      if (proc) proc.env.NODE_ENV = 'production';
      inMemoryAuthStores();
      inMemoryAuthStores();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('NODE_ENV=production');
    } finally {
      if (proc) proc.env.NODE_ENV = original;
      warn.mockRestore();
    }
  });

  it('never warns when silent is set, regardless of NODE_ENV', () => {
    const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
    const original = proc?.env.NODE_ENV;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      if (proc) proc.env.NODE_ENV = 'production';
      inMemoryAuthStores({ silent: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (proc) proc.env.NODE_ENV = original;
      warn.mockRestore();
    }
  });
});
