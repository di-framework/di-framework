/**
 * DI tokens.
 *
 * `Container.register` keys services by `serviceClass.name` and
 * `registerFactory` by a bare string, all in one flat global namespace. A token
 * called `'UserStore'` or `'KeyStore'` would therefore collide with an
 * application's own service of that name — and the failure mode is not an error,
 * it is a silent injection of the wrong instance. So every token this package
 * registers is namespaced.
 *
 * This deviates from `@di-framework/events`, which registers a bare
 * `'EventTransport'`. The deviation is deliberate: the names an auth package
 * wants are exactly the names an application is most likely to have already
 * taken.
 */

export const AUTH_STRATEGY = 'auth.Strategy';
export const AUTHORIZATION_MANAGER = 'auth.AuthorizationManager';
export const AUTH_STORES = 'auth.Stores';
export const AUTH_USERS = 'auth.UserStore';
export const AUTH_SESSIONS = 'auth.SessionStore';
export const AUTH_CREDENTIALS = 'auth.CredentialStore';
export const AUTH_STATE = 'auth.StateStore';
export const AUTH_REFRESH_TOKENS = 'auth.RefreshTokenStore';
export const AUTH_KEYS = 'auth.KeyStore';
export const AUTH_THROTTLE = 'auth.LoginThrottle';
export const AUTH_PASSWORD_HASHER = 'auth.PasswordHasher';
export const AUTH_SESSION_MANAGER = 'auth.SessionManager';
export const AUTH_PASSWORD_SERVICE = 'auth.PasswordService';
export const AUTH_TOKEN_SERVICE = 'auth.TokenService';
export const AUTH_REFRESH_SERVICE = 'auth.RefreshService';
export const AUTH_WEBAUTHN = 'auth.WebAuthnService';
export const AUTH_OAUTH = 'auth.OAuthClients';
export const AUTH_CSRF = 'auth.CsrfGuard';
export const AUTH_RUNTIME = 'auth.Runtime';

/** Every token this package registers, for diagnostics and teardown. */
export const AUTH_TOKENS = [
  AUTH_STRATEGY,
  AUTHORIZATION_MANAGER,
  AUTH_STORES,
  AUTH_USERS,
  AUTH_SESSIONS,
  AUTH_CREDENTIALS,
  AUTH_STATE,
  AUTH_REFRESH_TOKENS,
  AUTH_KEYS,
  AUTH_THROTTLE,
  AUTH_PASSWORD_HASHER,
  AUTH_SESSION_MANAGER,
  AUTH_PASSWORD_SERVICE,
  AUTH_TOKEN_SERVICE,
  AUTH_REFRESH_SERVICE,
  AUTH_WEBAUTHN,
  AUTH_OAUTH,
  AUTH_CSRF,
  AUTH_RUNTIME,
] as const;
