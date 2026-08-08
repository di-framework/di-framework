import { type ConditionalStorageAdapter, supportsConditionalWrite } from '@di-framework/repo';
import type {
  ApiKeyCredential,
  CredentialStore,
  KeyStore,
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
  UserRecord,
  UserStore,
  WebAuthnCredential,
} from './types.ts';

/**
 * Bridges the auth stores onto `@di-framework/repo`'s `StorageAdapter`, so any
 * backend that package supports works without a new adapter here.
 *
 * Structurally typed against the adapter protocol rather than importing the
 * concrete interface, so `@di-framework/repo` stays a genuinely optional peer.
 * Only `findById`, `save`, `delete`, and `findPaginated` are used —
 * `transaction` is optional in the protocol and not meaningfully implemented by
 * every adapter.
 *
 * A note on lookups: `findPaginated`'s filter format is, in the protocol's own
 * words, "deliberately loose — concrete adapters interpret it". So every
 * single-record lookup in this file goes through `findById` on the record's
 * primary key, and filters are used only for the genuinely multi-record queries
 * (list a user's passkeys, revoke a token family). Anything security-critical
 * resolves by key.
 */
export interface StorageAdapterLike<E, ID = string> {
  findById(id: ID): Promise<E | null>;
  save(entity: E): Promise<E>;
  delete(id: ID): Promise<boolean>;
  findPaginated(params: {
    page?: number;
    size?: number;
    sort?: string | string[];
    filter?: Record<string, unknown>;
    withDeleted?: boolean;
  }): Promise<{ items: E[]; total: number; page: number; size: number; pages: number }>;
}

/**
 * A compare-and-swap primitive.
 *
 * `StorageAdapter` has no conditional write, and three of the auth stores'
 * replay defences are meaningless without one — see the ATOMIC notes in
 * `./types.ts`. Rather than degrade silently, the stores that need it refuse to
 * be constructed unless one is supplied.
 *
 * Implement it with whatever your backend offers: an `UPDATE ... WHERE version =
 * ?` returning a row count, a Mongo `findOneAndUpdate` with a version predicate,
 * a DynamoDB conditional write, or Redis `WATCH`/`MULTI`.
 */
export interface AtomicOps<E> {
  /**
   * Apply `mutate` to the record at `id` only if it is still in the state
   * `mutate` observed. Return `false` when the condition failed (another writer
   * won the race), `true` when the write landed.
   *
   * `mutate` returns `null` to abort without writing.
   */
  compareAndSwap(id: string, mutate: (current: E | null) => E | null): Promise<boolean>;
  /** Read and delete indivisibly. Returns the record, or `null` if it was already gone. */
  takeOnce?(id: string): Promise<E | null>;
}

export interface RepoStoreOptions<E> {
  adapter: StorageAdapterLike<E>;
  /**
   * Maps this package's record fields onto your entity's field names, so the
   * auth package does not dictate your schema. Unmapped fields are used as-is.
   */
  fields?: Partial<Record<string, string>>;
  now?: () => number;
  /** Page size used when listing. Default 200. */
  pageSize?: number;
}

export interface AtomicRepoStoreOptions<E> extends RepoStoreOptions<E> {
  atomic?: AtomicOps<E>;
}

const seconds = () => Math.floor(Date.now() / 1000);

function mapper(fields?: Partial<Record<string, string>>) {
  if (!fields) return <T>(record: T): T => record;
  const entries = Object.entries(fields).filter(([, to]) => typeof to === 'string') as Array<
    [string, string]
  >;
  if (entries.length === 0) return <T>(record: T): T => record;
  return <T>(record: T): T => {
    const source = record as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    for (const [from, to] of entries) {
      if (from === to) continue;
      if (from in source) {
        out[to] = source[from];
        delete out[from];
      }
    }
    return out as unknown as T;
  };
}

function reverseMapper(fields?: Partial<Record<string, string>>) {
  if (!fields) return <T>(record: T): T => record;
  const inverted: Record<string, string> = {};
  for (const [from, to] of Object.entries(fields)) if (typeof to === 'string') inverted[to] = from;
  return mapper(inverted);
}

async function listAll<E>(
  adapter: StorageAdapterLike<E>,
  filter: Record<string, unknown>,
  pageSize: number,
): Promise<E[]> {
  const items: E[] = [];
  let page = 1;
  for (;;) {
    const result = await adapter.findPaginated({ page, size: pageSize, filter });
    items.push(...result.items);
    if (result.items.length < pageSize || page >= result.pages) break;
    page++;
  }
  return items;
}

export function repoUserStore(options: RepoStoreOptions<UserRecord>): UserStore {
  const { adapter } = options;
  const toEntity = mapper(options.fields);
  const toRecord = reverseMapper(options.fields);

  const findOneBy = async (field: string, value: string): Promise<UserRecord | null> => {
    const key = options.fields?.[field] ?? field;
    const { items } = await adapter.findPaginated({ page: 1, size: 2, filter: { [key]: value } });
    const first = items[0];
    return first ? toRecord(first) : null;
  };

  /** Keep `identifierKey` in step with `identifier` on every write. */
  const normalize = (user: UserRecord): UserRecord => {
    const identifier = user.identifier.trim();
    return { ...user, identifier, identifierKey: identifier.toLowerCase() };
  };

  return {
    async findById(id) {
      const found = await adapter.findById(id);
      return found ? toRecord(found) : null;
    },
    findByIdentifier: (identifier) => findOneBy('identifierKey', identifier.trim().toLowerCase()),
    findByWebAuthnHandle: (handle) => findOneBy('webauthnUserHandle', handle),
    async create(user) {
      return toRecord(await adapter.save(toEntity(normalize(user))));
    },
    async update(id, patch) {
      const existing = await adapter.findById(id);
      if (!existing) return null;
      return toRecord(
        await adapter.save(toEntity(normalize({ ...toRecord(existing), ...patch, id }))),
      );
    },
    delete: (id) => adapter.delete(id),
  };
}

export function repoSessionStore(options: RepoStoreOptions<SessionRecord>): SessionStore {
  const { adapter, pageSize = 200 } = options;
  const now = options.now ?? seconds;
  const toEntity = mapper(options.fields);
  const toRecord = reverseMapper(options.fields);
  const subjectKey = options.fields?.['subject'] ?? 'subject';

  return {
    async get(id) {
      // As stored, expired or not — `SessionManager` owns expiry evaluation.
      const found = await adapter.findById(id);
      return found ? toRecord(found) : null;
    },
    async create(session) {
      return toRecord(await adapter.save(toEntity(session)));
    },
    async touch(id, lastSeenAt) {
      const found = await adapter.findById(id);
      if (found) await adapter.save(toEntity({ ...toRecord(found), lastSeenAt }));
    },
    delete: (id) => adapter.delete(id),
    async deleteBySubject(subject) {
      const items = await listAll(adapter, { [subjectKey]: subject }, pageSize);
      let count = 0;
      for (const item of items) if (await adapter.delete(toRecord(item).id)) count++;
      return count;
    },
  };
}

export function repoCredentialStore(options: {
  passwords: StorageAdapterLike<PasswordCredential>;
  webauthn: StorageAdapterLike<WebAuthnCredential>;
  apiKeys: StorageAdapterLike<ApiKeyCredential>;
  atomic?: AtomicOps<WebAuthnCredential>;
  pageSize?: number;
}): CredentialStore {
  const pageSize = options.pageSize ?? 200;

  return {
    async findPassword(userId) {
      return options.passwords.findById(userId);
    },
    async savePassword(credential) {
      return options.passwords.save({ ...credential, id: credential.userId });
    },
    deletePassword: (userId) => options.passwords.delete(userId),

    findWebAuthn: (credentialId) => options.webauthn.findById(credentialId),
    listWebAuthn: (userId) => listAll(options.webauthn, { userId }, pageSize),
    saveWebAuthn: (credential) => options.webauthn.save(credential),
    deleteWebAuthn: (credentialId) => options.webauthn.delete(credentialId),
    async updateSignCount(credentialId, signCount, expectedVersion, lastUsedAt, backupState) {
      const atomicCas =
        options.atomic?.compareAndSwap ??
        (supportsConditionalWrite(options.webauthn)
          ? (
              id: string,
              mutate: (current: WebAuthnCredential | null) => WebAuthnCredential | null,
            ) =>
              (
                options.webauthn as unknown as ConditionalStorageAdapter<WebAuthnCredential>
              ).compareAndSwap(id, mutate)
          : undefined);

      if (!atomicCas) {
        throw new Error(
          'updateSignCount requires `atomic.compareAndSwap` or a ConditionalStorageAdapter on webauthn adapter.',
        );
      }

      return atomicCas(credentialId, (current) => {
        if (!current || current.version !== expectedVersion) return null;
        return {
          ...current,
          signCount,
          lastUsedAt,
          ...(backupState !== undefined ? { backupState } : {}),
          version: current.version + 1,
        };
      });
    },

    findApiKey: (hashedKey) => options.apiKeys.findById(hashedKey),
    listApiKeys: (userId) => listAll(options.apiKeys, { userId }, pageSize),
    saveApiKey: (credential) => options.apiKeys.save(credential),
    deleteApiKey: (hashedKey) => options.apiKeys.delete(hashedKey),
  };
}

interface StateEntity extends StateEntry {
  id: string;
}

/**
 * @throws when no {@link AtomicOps} and no conditional write capability is supplied. Single-use `state` and
 * single-use WebAuthn challenges are the entire point of this store, and a
 * read-then-delete implementation provides neither. Failing loudly at
 * construction is better than shipping a defence that silently does nothing.
 */
export function repoStateStore(options: AtomicRepoStoreOptions<StateEntity>): StateStore {
  const atomicTakeOnce =
    options.atomic?.takeOnce ??
    (supportsConditionalWrite(options.adapter)
      ? async (id: string) => {
          let taken: StateEntity | null = null;
          const won = await (
            options.adapter as unknown as ConditionalStorageAdapter<StateEntity>
          ).compareAndSwap(id, (current) => {
            if (!current || (current as any).consumed) return null;
            taken = current;
            return { ...current, consumed: true } as StateEntity;
          });
          if (!won || !taken) return null;
          await options.adapter.delete(id);
          return taken;
        }
      : undefined);

  if (!atomicTakeOnce) {
    throw new Error(
      'repoStateStore requires `atomic.takeOnce` — an indivisible read-and-delete. ' +
        'OAuth `state` and WebAuthn challenges must be single-use, and a read followed by a ' +
        'delete lets two concurrent replays both succeed. Implement takeOnce with your ' +
        "backend's conditional delete (SQL DELETE ... RETURNING, Mongo findOneAndDelete, " +
        'Redis GETDEL), or use `memoryStateStore()`.',
    );
  }
  const { adapter } = options;
  const now = options.now ?? seconds;
  const compose = (purpose: StatePurpose, key: string) => `${purpose} ${key}`;

  return {
    async put(entry) {
      await adapter.save({ ...entry, id: compose(entry.purpose, entry.key) });
    },
    async consume<T = Record<string, unknown>>(purpose: StatePurpose, key: string) {
      const taken = await atomicTakeOnce(compose(purpose, key));
      if (!taken) return null;
      if (taken.expiresAt <= now()) return null;
      const { id: _id, ...entry } = taken;
      return entry as StateEntry<T>;
    },
  };
}

/**
 * @throws when no {@link AtomicOps} and no conditional write capability is supplied. Refresh-token reuse detection
 * is a compare-and-swap on `rotatedAt`; without one, two concurrent refreshes
 * both succeed and a stolen token is never detected.
 */
export function repoRefreshTokenStore(
  options: AtomicRepoStoreOptions<RefreshTokenRecord>,
): RefreshTokenStore {
  const atomicCas =
    options.atomic?.compareAndSwap ??
    (supportsConditionalWrite(options.adapter)
      ? (id: string, mutate: (current: RefreshTokenRecord | null) => RefreshTokenRecord | null) =>
          (
            options.adapter as unknown as ConditionalStorageAdapter<RefreshTokenRecord>
          ).compareAndSwap(id, mutate)
      : undefined);

  if (!atomicCas) {
    throw new Error(
      'repoRefreshTokenStore requires `atomic.compareAndSwap`. Refresh-token rotation must ' +
        'fail when the token has already been exchanged, which a read followed by a write ' +
        'cannot guarantee. Implement compareAndSwap with a conditional update ' +
        '(UPDATE ... WHERE rotated_at IS NULL), or use `memoryRefreshTokenStore()`.',
    );
  }
  const { adapter, pageSize = 200 } = options;
  const now = options.now ?? seconds;

  return {
    async issue(record) {
      return adapter.save(record);
    },
    find: (id) => adapter.findById(id),
    async rotate(id, next, rotatedAt): Promise<RefreshRotateResult> {
      const existing = await adapter.findById(id);
      if (!existing) return { outcome: 'not-found' };
      if (existing.rotatedAt !== undefined) return { outcome: 'reused', record: existing };
      if (existing.expiresAt <= now()) return { outcome: 'expired', record: existing };

      const won = await atomicCas(id, (current) =>
        current && current.rotatedAt === undefined ? { ...current, rotatedAt } : null,
      );
      // Losing the race means another request rotated this token first — which,
      // from this request's point of view, is exactly reuse.
      if (!won) return { outcome: 'reused', record: existing };

      await adapter.save(next);
      return { outcome: 'rotated', record: next };
    },
    async revokeFamily(familyId) {
      const items = await listAll(adapter, { familyId }, pageSize);
      let count = 0;
      for (const item of items) if (await adapter.delete(item.id)) count++;
      return count;
    },
    async revokeBySubject(subject) {
      const items = await listAll(adapter, { subject }, pageSize);
      let count = 0;
      for (const item of items) if (await adapter.delete(item.id)) count++;
      return count;
    },
  };
}

interface KeyEntity extends SigningKeyRecord {
  id: string;
  current?: boolean;
}

export function repoKeyStore(options: RepoStoreOptions<KeyEntity>): KeyStore {
  const { adapter, pageSize = 50 } = options;
  const now = options.now ?? seconds;
  const strip = ({ id: _id, current: _current, ...key }: KeyEntity): SigningKeyRecord => key;

  return {
    async current() {
      const { items } = await adapter.findPaginated({
        page: 1,
        size: 1,
        filter: { current: true },
      });
      const first = items[0];
      if (!first) {
        throw new Error(
          'No current signing key in the key store. Save one with ' +
            '`keyStore.save(await generateSigningKey())`.',
        );
      }
      return strip(first);
    },
    async all() {
      const at = now();
      const items = await listAll(adapter, {}, pageSize);
      return items
        .filter((key) => !key.expiresAt || key.expiresAt > at)
        .sort((a, b) => (a.current ? -1 : b.current ? 1 : b.createdAt - a.createdAt))
        .map(strip);
    },
    async find(kid) {
      const found = await adapter.findById(kid);
      return found ? strip(found) : null;
    },
    async save(key) {
      const at = now();
      const becomesCurrent = !key.notAfter || key.notAfter > at;
      if (becomesCurrent) {
        for (const existing of await listAll(adapter, { current: true }, pageSize)) {
          await adapter.save({ ...existing, current: false });
        }
      }
      await adapter.save({ ...key, id: key.kid, current: becomesCurrent });
      return key;
    },
    delete: (kid) => adapter.delete(kid),
  };
}
