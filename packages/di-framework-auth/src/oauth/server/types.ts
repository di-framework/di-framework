import type { AuthorizationManager } from '../../authorization.ts';
import type { KeyService } from '../../tokens/keystore.ts';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  allowedGrantTypes: string[];
  allowedScopes: string[];
  isPublic?: boolean;
}

export interface OAuthAuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  subjectId: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  nonce?: string;
  expiresAt: number;
  createdAt: number;
  consumed?: boolean;
}

export interface OAuthConsent {
  clientId: string;
  subjectId: string;
  scopes: string[];
  grantedAt: number;
}

export interface OAuthRefreshTokenRecord {
  token: string;
  clientId: string;
  subjectId: string;
  scope: string;
  expiresAt: number;
  revoked: boolean;
}

export interface ClientStore {
  getClient(clientId: string): Promise<OAuthClientConfig | null>;
}

export interface AuthCodeStore {
  createCode(code: OAuthAuthorizationCode): Promise<void>;
  consumeCode(code: string): Promise<OAuthAuthorizationCode | null>;
}

export interface ConsentStore {
  getConsent(clientId: string, subjectId: string): Promise<OAuthConsent | null>;
  saveConsent(consent: OAuthConsent): Promise<void>;
}

export interface OAuthTokenStore {
  saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void>;
  revokeToken(token: string): Promise<boolean>;
  isRevoked(tokenId: string): Promise<boolean>;
}

export interface OAuthAuthorizationServerOptions {
  issuer: string;
  keyService: KeyService;
  clientStore: ClientStore;
  authCodeStore: AuthCodeStore;
  consentStore?: ConsentStore;
  tokenStore?: OAuthTokenStore;
  authorizationManager?: AuthorizationManager;
  accessTokenLifetimeSeconds?: number;
  refreshTokenLifetimeSeconds?: number;
  codeLifetimeSeconds?: number;
  now?: () => number;
}

export interface AuthorizationRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  nonce?: string;
}

export type AuthorizationResult =
  | { type: 'redirect'; redirectUri: string; code: string; state?: string }
  | { type: 'login_required'; state?: string }
  | { type: 'consent_required'; client: OAuthClientConfig; scopes: string[]; state?: string };

export interface TokenRequest {
  grantType: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  scope?: string;
}

export interface OAuthTokenGrant {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

export interface OpenIDDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
}
