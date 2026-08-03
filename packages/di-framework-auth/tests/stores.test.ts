import { describe, expect, it } from 'bun:test';
import { InMemoryRepository } from '@di-framework/repo';
import {
  inMemoryAuthStores,
  memoryLoginThrottle,
  memoryStateStore,
} from '../src/providers/memory.ts';
import {
  type AtomicOps,
  repoRefreshTokenStore,
  repoSessionStore,
  repoStateStore,
  repoUserStore,
  type StorageAdapterLike,
} from '../src/providers/repo.ts';
import type {
  RefreshTokenRecord,
  SessionRecord,
  SessionStore,
  StateStore,
  UserRecord,
  UserStore,
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
