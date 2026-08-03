import type { Principal } from '../principal.ts';
import type { SignatureAlgorithm } from '../tokens/algorithms.ts';
import type { JwtClaims } from '../tokens/jwt.ts';

export interface OAuthProvider {
  /** Stable key, used in route paths and as the state-store namespace. */
  id: string;
  /** OIDC issuer. Enables discovery; required unless endpoints are given explicitly. */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  clientId: string;
  clientSecret?: string;
  clientAuth?: 'client_secret_basic' | 'client_secret_post' | 'none';
  /**
   * Exactly one redirect URI, matched by the authorization server against its
   * registration by exact string comparison.
   *
   * Deliberately not an array. RFC 9700 §4.1 requires exact matching, and one
   * callback path per provider is what prevents the classic mix-up attack — a
   * shared callback that dispatches on `state` cannot tell which provider it is
   * talking to before it has already trusted the response.
   */
  redirectUri: string;
  scopes?: readonly string[];
  idTokenSignedResponseAlg?: readonly SignatureAlgorithm[];
  /**
   * `true` (default) expects an `id_token`. Set `false` for plain OAuth2
   * providers such as GitHub, which have no ID token and no nonce.
   */
  oidc?: boolean;
  extraAuthorizationParams?: Record<string, string>;
  /** Map provider claims onto a normalised profile. */
  profileMap?: (claims: JwtClaims | null, userinfo: Record<string, unknown> | null) => OAuthProfile;
  /** Permit `http://` loopback endpoints, for local development. */
  allowInsecureHttp?: boolean;
}

export interface OAuthProfile {
  subject: string;
  issuer: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  raw: Record<string, unknown>;
}

export interface OAuthTokens {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
  idToken?: string;
  scope?: readonly string[];
}

export interface AuthorizationRequest {
  /** Redirect the user agent here. */
  url: string;
  state: string;
  nonce: string;
  /** Never leaves the server; held in the state store. */
  codeVerifier: string;
  /** `Set-Cookie` value binding the callback to this user agent. */
  stateCookie: string;
  expiresAt: number;
}

export interface CallbackResult {
  tokens: OAuthTokens;
  idTokenClaims?: JwtClaims;
  profile: OAuthProfile;
  principal: Principal;
  returnTo?: string;
  /** `Set-Cookie` value that clears the state cookie. */
  clearStateCookie: string;
}
