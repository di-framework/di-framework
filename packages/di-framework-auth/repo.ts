/**
 * `@di-framework/repo` storage bridge.
 *
 * A subpath export so `@di-framework/repo` stays a genuinely optional peer.
 */
export {
  type AtomicOps,
  type AtomicRepoStoreOptions,
  type RepoStoreOptions,
  repoCredentialStore,
  repoKeyStore,
  repoRefreshTokenStore,
  repoSessionStore,
  repoStateStore,
  repoUserStore,
  type StorageAdapterLike,
} from './src/providers/repo.ts';
