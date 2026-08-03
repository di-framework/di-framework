/** OAuth 2.0 / OpenID Connect relying party. Dependency-free; subpathed for tree-shaking. */

export {
  type OAuthClient,
  type OAuthClientOptions,
  oauthClient,
} from './src/oauth/client.ts';
export {
  type Discovery,
  type DiscoveryOptions,
  discovery,
  type OidcMetadata,
  validateMetadata,
  wellKnownUrl,
} from './src/oauth/discovery.ts';
export {
  computeTokenHash,
  type IdTokenValidationOptions,
  validateIdToken,
} from './src/oauth/id-token.ts';
export {
  computeS256Challenge,
  generateCodeVerifier,
  generatePkce,
  isValidCodeVerifier,
  type PkcePair,
} from './src/oauth/pkce.ts';
export {
  genericOidcProvider,
  githubProvider,
  googleProvider,
  microsoftEntraProvider,
  type OAuthPresetConfig,
} from './src/oauth/presets.ts';
export type {
  AuthorizationRequest,
  CallbackResult,
  OAuthProfile,
  OAuthProvider,
  OAuthTokens,
} from './src/oauth/types.ts';
