import type { OAuthProfile, OAuthProvider } from './types.ts';

/**
 * Provider presets.
 *
 * Google and Entra are pure discovery-driven OIDC. GitHub is here deliberately
 * as the *non*-OIDC case — no discovery document, no `id_token`, no `nonce`,
 * and a profile that has to be fetched from a bespoke endpoint. A relying-party
 * design that only ever saw OIDC providers would quietly assume an ID token
 * exists; including GitHub in v1 keeps that assumption out of the interface.
 */

export interface OAuthPresetConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
  extraAuthorizationParams?: Record<string, string>;
}

export function googleProvider(config: OAuthPresetConfig): OAuthProvider {
  return {
    id: 'google',
    issuer: 'https://accounts.google.com',
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    clientAuth: config.clientSecret ? 'client_secret_post' : 'none',
    scopes: config.scopes ?? ['openid', 'profile', 'email'],
    idTokenSignedResponseAlg: ['RS256'],
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.extraAuthorizationParams
      ? { extraAuthorizationParams: config.extraAuthorizationParams }
      : {}),
  };
}

export function microsoftEntraProvider(
  config: OAuthPresetConfig & { tenant?: string },
): OAuthProvider {
  const tenant = config.tenant ?? 'common';
  return {
    id: 'microsoft',
    // The well-known path is appended after this path, not at the host root —
    // see `wellKnownUrl` in ./discovery.ts.
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    clientAuth: config.clientSecret ? 'client_secret_post' : 'none',
    scopes: config.scopes ?? ['openid', 'profile', 'email'],
    idTokenSignedResponseAlg: ['RS256'],
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.extraAuthorizationParams
      ? { extraAuthorizationParams: config.extraAuthorizationParams }
      : {}),
  };
}

/**
 * GitHub — plain OAuth 2.0, no OpenID Connect.
 *
 * There is no `id_token`, so identity comes entirely from the userinfo call, and
 * `nonce` is meaningless. `state` plus PKCE plus the state cookie remain the
 * full defence for the callback.
 */
export function githubProvider(config: OAuthPresetConfig): OAuthProvider {
  return {
    id: 'github',
    oidc: false,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userinfoEndpoint: 'https://api.github.com/user',
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    clientAuth: config.clientSecret ? 'client_secret_post' : 'none',
    scopes: config.scopes ?? ['read:user', 'user:email'],
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.extraAuthorizationParams
      ? { extraAuthorizationParams: config.extraAuthorizationParams }
      : {}),
    profileMap: (_claims, userinfo): OAuthProfile => {
      const source = userinfo ?? {};
      const id = source.id;
      return {
        subject: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
        issuer: 'https://github.com',
        ...(typeof source.email === 'string' ? { email: source.email } : {}),
        ...(typeof source.name === 'string'
          ? { name: source.name }
          : typeof source.login === 'string'
            ? { name: source.login }
            : {}),
        ...(typeof source.avatar_url === 'string' ? { picture: source.avatar_url } : {}),
        raw: source,
      };
    },
  };
}

/** Any standards-compliant OIDC provider, configured by issuer. */
export function genericOidcProvider(
  config: OAuthPresetConfig & {
    id?: string;
    issuer: string;
    clientAuth?: OAuthProvider['clientAuth'];
  },
): OAuthProvider {
  return {
    id: config.id ?? 'oidc',
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    clientAuth: config.clientAuth ?? (config.clientSecret ? 'client_secret_basic' : 'none'),
    scopes: config.scopes ?? ['openid', 'profile', 'email'],
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.extraAuthorizationParams
      ? { extraAuthorizationParams: config.extraAuthorizationParams }
      : {}),
  };
}
