/**
 * `@di-framework/auth` — authentication for di-framework.
 *
 * This entry point is dependency-free: it must not reach `itty-router`,
 * `graphql`, or `@di-framework/repo`, so that a consumer with none of them
 * installed can still import it. The integrations live behind subpath exports:
 * `@di-framework/auth/http`, `/graphql`, `/repo`, `/webauthn`, `/oauth`.
 */

export {
  type BunPasswordOptions,
  bunPasswordHasher,
  type NodeScryptOptions,
  nodeScryptHasher,
} from './src/adapters/argon2.ts';
export {
  authenticate,
  type ChainOptions,
  chain,
  challengesOf,
  requireAuthentication,
} from './src/chain.ts';
export { makeContext } from './src/context.ts';
export {
  adjustCookieName,
  assertCookiePolicy,
  type CookieAttributes,
  CSRF_COOKIE_NAME,
  clearCookie,
  DEFAULT_COOKIE_ATTRIBUTES,
  OAUTH_STATE_COOKIE_NAME,
  parseCookies,
  readCookie,
  SESSION_COOKIE_NAME,
  serializeCookie,
  WEBAUTHN_COOKIE_NAME,
} from './src/cookies.ts';
export { AeadError, open, openJson, seal, sealJson } from './src/crypto/aead.ts';
export {
  Base64UrlError,
  base64UrlDecode,
  base64UrlDecodeString,
  base64UrlEncode,
  base64UrlEncodeString,
  isBase64Url,
} from './src/crypto/base64url.ts';
export { timingSafeEqual, timingSafeEqualString } from './src/crypto/compare.ts';
export { concatBytes, digest, hashSecret, sha256, sha384, sha512 } from './src/crypto/hash.ts';
export {
  deriveAesKey,
  deriveHmacKey,
  hkdf,
  KDF_LABELS,
  MIN_SECRET_BYTES,
  toSecretBytes,
} from './src/crypto/kdf.ts';
export {
  type PasswordHasher,
  PBKDF2_DEFAULT_ITERATIONS,
  type Pbkdf2Options,
  pbkdf2Hasher,
} from './src/crypto/password-hasher.ts';
export { randomBytes, randomId, randomToken } from './src/crypto/random.ts';
export {
  type CsrfGuard,
  type CsrfOptions,
  type CsrfVerdict,
  checkRequestOrigin,
  csrfGuard,
  requiresCsrfCheck,
} from './src/csrf.ts';
export {
  AuthError,
  type AuthErrorOptions,
  AuthenticationError,
  isAuthError,
} from './src/errors.ts';
export {
  type PasswordPolicy,
  type PasswordService,
  type PasswordServiceOptions,
  passwordService,
} from './src/password.ts';
export {
  type AuthMethod,
  createPrincipal,
  hasAmr,
  isExpired,
  type Principal,
} from './src/principal.ts';
export {
  inMemoryAuthStores,
  type MemoryStoreOptions,
  type MemoryThrottleOptions,
  memoryCredentialStore,
  memoryKeyStore,
  memoryLoginThrottle,
  memoryRefreshTokenStore,
  memorySessionStore,
  memoryStateStore,
  memoryUserStore,
} from './src/providers/memory.ts';
export type {
  ApiKeyCredential,
  AuthStores,
  Credential,
  CredentialKind,
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
} from './src/providers/types.ts';
export {
  Auth,
  type AuthRuntime,
  type JwtConfig,
  type RegisterAuthOptions,
  registerAuth,
  type TokenService,
} from './src/register.ts';
export {
  type AuthErrorCode,
  type AuthFailure,
  type AuthNoCredential,
  type AuthResult,
  type AuthSuccess,
  authenticated,
  authFailed,
  isAuthenticated,
  isFailure,
  isNoCredential,
  noCredential,
} from './src/result.ts';
export {
  type CreateSessionInput,
  type IssuedSession,
  type SessionLookup,
  type SessionManager,
  type SessionManagerOptions,
  sessionManager,
} from './src/session/manager.ts';
export {
  AAL1_POLICY,
  AAL2_POLICY,
  AAL3_POLICY,
  DEFAULT_SESSION_POLICY,
  resolveSessionPolicy,
  type SessionPolicy,
} from './src/session/policy.ts';
export {
  type ApiKeyStrategyOptions,
  apiKeyStrategy,
  type BearerTokenStrategyOptions,
  bearerTokenStrategy,
  type IssuedApiKey,
  issueApiKey,
  type SessionCookieStrategyOptions,
  sessionCookieStrategy,
} from './src/strategies/index.ts';
export {
  ALGORITHMS,
  type AlgorithmSpec,
  algorithmSpec,
  DEFAULT_ALGORITHM,
  isAlgorithmSupported,
  isSignatureAlgorithm,
  type SignatureAlgorithm,
} from './src/tokens/algorithms.ts';
export {
  type GeneratedKeyPair,
  generateKeyPair,
  importHmacKey,
  importJwk,
  type Jwk,
  type JwkSet,
  jwkThumbprint,
  toPublicJwk,
} from './src/tokens/jwk.ts';
export {
  fetchJson,
  type RemoteJwks,
  type RemoteJwksOptions,
  remoteJwks,
} from './src/tokens/jwks.ts';
export {
  decodeJwsHeader,
  derToP1363,
  type JwsHeader,
  p1363ToDer,
  type SignJwsOptions,
  signJws,
  type VerifiedJws,
  type VerifyJwsOptions,
  verifyJws,
} from './src/tokens/jws.ts';
export {
  decodeJwtUnsafe,
  type JwtClaims,
  type SignJwtOptions,
  signJwt,
  type VerifiedJwt,
  type VerifyJwtOptions,
  verifyJwt,
} from './src/tokens/jwt.ts';
export { type KeyService, type KeyServiceOptions, keyService } from './src/tokens/keystore.ts';
export {
  type IssuedRefreshToken,
  type RefreshedToken,
  type RefreshService,
  type RefreshServiceOptions,
  refreshService,
} from './src/tokens/refresh.ts';
export {
  AUTH_CREDENTIALS,
  AUTH_CSRF,
  AUTH_KEYS,
  AUTH_PASSWORD_HASHER,
  AUTH_PASSWORD_SERVICE,
  AUTH_REFRESH_SERVICE,
  AUTH_REFRESH_TOKENS,
  AUTH_RUNTIME,
  AUTH_SESSION_MANAGER,
  AUTH_SESSIONS,
  AUTH_STATE,
  AUTH_STORES,
  AUTH_STRATEGY,
  AUTH_THROTTLE,
  AUTH_TOKEN_SERVICE,
  AUTH_TOKENS,
  AUTH_USERS,
  AUTH_WEBAUTHN,
} from './src/tokens.ts';
export type { AuthContainer, AuthRequestContext, AuthStrategy } from './src/types.ts';
