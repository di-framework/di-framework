import { useContainer } from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import { chain } from './chain.ts';
import type { CookieAttributes } from './cookies.ts';
import { deriveHmacKey, KDF_LABELS, toSecretBytes } from './crypto/kdf.ts';
import { type PasswordHasher, pbkdf2Hasher } from './crypto/password-hasher.ts';
import { type CsrfGuard, type CsrfOptions, csrfGuard } from './csrf.ts';
import { type PasswordPolicy, type PasswordService, passwordService } from './password.ts';
import { inMemoryAuthStores } from './providers/memory.ts';
import type { AuthStores } from './providers/types.ts';
import { type SessionManager, sessionManager } from './session/manager.ts';
import type { SessionPolicy } from './session/policy.ts';
import { apiKeyStrategy } from './strategies/api-key.ts';
import { bearerTokenStrategy } from './strategies/bearer.ts';
import { sessionCookieStrategy } from './strategies/session-cookie.ts';
import type { SignatureAlgorithm } from './tokens/algorithms.ts';
import { type JwtClaims, signJwt } from './tokens/jwt.ts';
import { type KeyService, keyService } from './tokens/keystore.ts';
import { type RefreshService, refreshService } from './tokens/refresh.ts';
import {
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
  AUTH_USERS,
  AUTH_WEBAUTHN,
} from './tokens.ts';
import type { AuthContainer, AuthStrategy } from './types.ts';
import { type WebAuthnService, webAuthnService } from './webauthn/service.ts';
import type { WebAuthnConfig } from './webauthn/types.ts';

/**
 * Wire the auth package into a DI container.
 *
 * Follows the shape of `registerConfig` in `@di-framework/config`: values are
 * built here and registered as singleton factories through a loose structural
 * container interface.
 *
 * **Everything is constructed eagerly and synchronously.** `Container.resolve`
 * is synchronous, so a factory cannot await. That is why signing-key generation,
 * JWKS fetching, and OIDC discovery are all lazy-on-first-use behind a cached
 * in-flight promise rather than happening here — see `tokens/keystore.ts`,
 * `tokens/jwks.ts`, and `oauth/discovery.ts`.
 */

export interface JwtConfig {
  issuer: string;
  audience: string | string[];
  /** Asymmetric by default; see `DEFAULT_ALGORITHM`. */
  algorithm?: SignatureAlgorithm;
  /** Access-token lifetime. Default 900 (15 minutes). */
  accessTtlSeconds?: number;
  /** Refresh-token lifetime. Default 30 days. */
  refreshTtlSeconds?: number;
  /**
   * Use HS256 with a key derived from the master secret instead of an
   * asymmetric key pair. Simpler for a single service; unsuitable the moment a
   * second service needs to verify without being able to mint.
   */
  symmetric?: boolean;
}

export interface RegisterAuthOptions {
  container?: AuthContainer;
  /**
   * Master secret, at least 32 bytes. HKDF-expanded into the CSRF key, the
   * cookie AEAD key, and (when `jwt.symmetric`) the HS256 key.
   */
  secret?: Uint8Array | string;
  /** Partial overrides; anything omitted falls back to the in-memory store. */
  stores?: Partial<AuthStores>;
  hasher?: PasswordHasher;
  session?: Partial<SessionPolicy>;
  cookie?: CookieAttributes;
  password?: PasswordPolicy;
  csrf?: Omit<CsrfOptions, 'secret'> | false;
  jwt?: JwtConfig;
  webauthn?: WebAuthnConfig;
  /** Strategies to compose. Defaults to session + bearer (when `jwt` is set). */
  strategies?: readonly AuthStrategy[];
  now?: () => number;
}

export interface TokenService {
  /** Mint a short-lived access token for a subject. */
  issueAccessToken(input: {
    subject: string;
    claims?: JwtClaims;
    amr?: readonly string[];
    authTime?: number;
  }): Promise<{ token: string; expiresIn: number }>;
  keys: KeyService;
  config: JwtConfig;
}

export interface AuthRuntime {
  stores: AuthStores;
  hasher: PasswordHasher;
  sessions: SessionManager;
  passwords: PasswordService;
  strategy: AuthStrategy;
  csrf?: CsrfGuard;
  tokens?: TokenService;
  refresh?: RefreshService;
  webauthn?: WebAuthnService;
  cookie: CookieAttributes;
}

function resolveContainer(container?: AuthContainer): AuthContainer {
  return container ?? (useContainer() as unknown as AuthContainer);
}

export function registerAuth(options: RegisterAuthOptions = {}): AuthRuntime {
  const container = resolveContainer(options.container);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const defaults = inMemoryAuthStores({ now });
  const stores: AuthStores = { ...defaults, ...options.stores };
  const hasher = options.hasher ?? pbkdf2Hasher();

  // Fail here rather than at the first request: a missing secret means the CSRF
  // MAC and any symmetric token key would have to come from somewhere, and every
  // alternative (a random per-process value, a hardcoded default) is worse than
  // an error at startup.
  const secret = options.secret;
  if (secret !== undefined) toSecretBytes(secret);

  const sessions = sessionManager({
    store: stores.sessions,
    ...(options.session ? { policy: options.session } : {}),
    now,
  });

  const passwords = passwordService({
    users: stores.users,
    credentials: stores.credentials,
    hasher,
    throttle: stores.throttle,
    ...(options.password ? { policy: options.password } : {}),
    now,
  });

  let csrf: CsrfGuard | undefined;
  if (options.csrf !== false) {
    if (secret === undefined) {
      throw new Error(
        'registerAuth() needs a `secret` of at least 32 bytes to derive the CSRF key. ' +
          'Pass one, or set `csrf: false` if every client authenticates with a bearer token ' +
          'or API key (those cannot be forged cross-site and need no CSRF token).',
      );
    }
    csrf = csrfGuard({ ...options.csrf, secret });
  }

  let tokens: TokenService | undefined;
  let refresh: RefreshService | undefined;
  if (options.jwt) {
    const jwt = options.jwt;
    const accessTtl = jwt.accessTtlSeconds ?? 900;
    const keys = keyService({
      store: stores.keys,
      ...(jwt.algorithm ? { algorithm: jwt.algorithm } : {}),
      now,
    });

    // Derived lazily so a symmetric deployment still does no async work during
    // registration.
    let symmetricKey: Promise<CryptoKey> | undefined;
    const signingMaterial = async (): Promise<{
      algorithm: SignatureAlgorithm;
      key: CryptoKey;
      kid?: string;
    }> => {
      if (jwt.symmetric) {
        if (secret === undefined) {
          throw new Error('registerAuth({ jwt: { symmetric: true } }) requires a `secret`');
        }
        symmetricKey ??= deriveHmacKey(secret, KDF_LABELS.hs256, ['sign', 'verify']);
        return { algorithm: 'HS256', key: await symmetricKey };
      }
      const { record, key } = await keys.signingKey();
      return { algorithm: record.algorithm as SignatureAlgorithm, key, kid: record.kid };
    };

    tokens = {
      keys,
      config: jwt,
      async issueAccessToken(input) {
        const material = await signingMaterial();
        const token = await signJwt(
          {
            ...input.claims,
            ...(input.amr ? { amr: input.amr } : {}),
            ...(input.authTime !== undefined ? { auth_time: input.authTime } : {}),
          },
          {
            algorithm: material.algorithm,
            key: material.key,
            ...(material.kid ? { kid: material.kid } : {}),
            issuer: jwt.issuer,
            audience: jwt.audience,
            subject: input.subject,
            expiresInSeconds: accessTtl,
            now,
          },
        );
        return { token, expiresIn: accessTtl };
      },
    };

    refresh = refreshService({
      store: stores.refreshTokens,
      ...(jwt.refreshTtlSeconds !== undefined ? { ttlSeconds: jwt.refreshTtlSeconds } : {}),
      now,
    });
  }

  const webauthn = options.webauthn
    ? webAuthnService({
        config: { now, ...options.webauthn },
        credentials: stores.credentials,
        state: stores.state,
        users: stores.users,
      })
    : undefined;

  const built: AuthStrategy[] = [];
  if (options.strategies) {
    built.push(...options.strategies);
  } else {
    built.push(sessionCookieStrategy({ sessions, ...(csrf ? { csrf } : {}) }));
    if (tokens) {
      built.push(
        bearerTokenStrategy({
          algorithms: options.jwt?.symmetric ? ['HS256'] : [options.jwt?.algorithm ?? 'ES256'],
          key: (header) => tokens!.keys.verificationKey(header),
          issuer: options.jwt!.issuer,
          audience: options.jwt!.audience,
          now,
        }),
      );
    }
    built.push(apiKeyStrategy({ credentials: stores.credentials, users: stores.users, now }));
  }
  const strategy = built.length === 1 ? built[0]! : chain(built);

  const runtime: AuthRuntime = {
    stores,
    hasher,
    sessions,
    passwords,
    strategy,
    cookie: options.cookie ?? {},
    ...(csrf ? { csrf } : {}),
    ...(tokens ? { tokens } : {}),
    ...(refresh ? { refresh } : {}),
    ...(webauthn ? { webauthn } : {}),
  };

  register(container, AUTH_RUNTIME, runtime);
  register(container, AUTH_STORES, stores);
  register(container, AUTH_USERS, stores.users);
  register(container, AUTH_SESSIONS, stores.sessions);
  register(container, AUTH_CREDENTIALS, stores.credentials);
  register(container, AUTH_STATE, stores.state);
  register(container, AUTH_REFRESH_TOKENS, stores.refreshTokens);
  register(container, AUTH_KEYS, stores.keys);
  register(container, AUTH_THROTTLE, stores.throttle);
  register(container, AUTH_PASSWORD_HASHER, hasher);
  register(container, AUTH_SESSION_MANAGER, sessions);
  register(container, AUTH_PASSWORD_SERVICE, passwords);
  register(container, AUTH_STRATEGY, strategy);
  if (csrf) register(container, AUTH_CSRF, csrf);
  if (tokens) register(container, AUTH_TOKEN_SERVICE, tokens);
  if (refresh) register(container, AUTH_REFRESH_SERVICE, refresh);
  if (webauthn) register(container, AUTH_WEBAUTHN, webauthn);

  return runtime;
}

function register(container: AuthContainer, token: string, value: unknown): void {
  if (!container.registerFactory) {
    throw new Error(
      'The supplied container does not implement registerFactory, which registerAuth() needs.',
    );
  }
  container.registerFactory(token, () => value, { singleton: true });
}

/**
 * Class decorator sugar over {@link registerAuth}, mirroring `@Configuration`
 * from `@di-framework/config`. The decorated class becomes a singleton whose
 * instance carries the {@link AuthRuntime}.
 */
export function Auth(options: RegisterAuthOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: decorators operate on arbitrary constructors.
  return <C extends new (...args: any[]) => any>(target: C): C => {
    const runtime = registerAuth(options);
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const AuthClass = class extends (target as any) {
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      constructor(...args: any[]) {
        super(...args);
        Object.assign(this, runtime);
      }
    };
    Object.defineProperty(AuthClass, 'name', { value: target.name });
    ContainerDecorator({ singleton: true, container: options.container as never })(AuthClass);
    return AuthClass as unknown as C;
  };
}
