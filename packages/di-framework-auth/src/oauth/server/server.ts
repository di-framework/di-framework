import { AuthError } from '../../errors.ts';
import type { SignatureAlgorithm } from '../../tokens/algorithms.ts';
import { signJwt, verifyJwt } from '../../tokens/jwt.ts';
import { computeS256Challenge, isValidCodeVerifier } from '../pkce.ts';
import { InMemoryAuthCodeStore, InMemoryConsentStore, InMemoryOAuthTokenStore } from './stores.ts';
import type {
  AuthCodeStore,
  AuthorizationRequest,
  AuthorizationResult,
  ClientStore,
  ConsentStore,
  OAuthAuthorizationCode,
  OAuthAuthorizationServerOptions,
  OAuthClientConfig,
  OAuthConsent,
  OAuthRefreshTokenRecord,
  OAuthTokenGrant,
  OAuthTokenStore,
  OpenIDDiscoveryDocument,
  TokenRequest,
} from './types.ts';

export class AuthorizationServer {
  private issuer: string;
  private keyService;
  private clientStore: ClientStore;
  private authCodeStore: AuthCodeStore;
  private consentStore: ConsentStore;
  private tokenStore: OAuthTokenStore;
  private authorizationManager;
  private accessTokenLifetimeSeconds: number;
  private refreshTokenLifetimeSeconds: number;
  private codeLifetimeSeconds: number;
  private now: () => number;

  constructor(options: OAuthAuthorizationServerOptions) {
    this.issuer = options.issuer;
    this.keyService = options.keyService;
    this.clientStore = options.clientStore;
    this.authCodeStore = options.authCodeStore;
    this.consentStore = options.consentStore ?? new InMemoryConsentStore();
    this.tokenStore = options.tokenStore ?? new InMemoryOAuthTokenStore();
    this.authorizationManager = options.authorizationManager;
    this.accessTokenLifetimeSeconds = options.accessTokenLifetimeSeconds ?? 3600;
    this.refreshTokenLifetimeSeconds = options.refreshTokenLifetimeSeconds ?? 2592000; // 30 days
    this.codeLifetimeSeconds = options.codeLifetimeSeconds ?? 600;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Handle an OAuth 2.0 Authorization Request (RFC 6749 §4.1.1).
   */
  async authorize(
    request: AuthorizationRequest,
    currentSubjectId?: string,
  ): Promise<AuthorizationResult> {
    if (request.responseType !== 'code') {
      throw new AuthError(
        `Unsupported response_type '${request.responseType}'. Only 'code' is supported.`,
        { status: 400, code: 'unsupported_response_type' },
      );
    }

    const client = await this.clientStore.getClient(request.clientId);
    if (!client) {
      throw new AuthError(`Unknown client_id '${request.clientId}'`, {
        status: 400,
        code: 'invalid_client',
      });
    }

    // Exact redirect URI validation (fail closed)
    if (!request.redirectUri || !client.redirectUris.includes(request.redirectUri)) {
      throw new AuthError(
        `Invalid redirect_uri '${request.redirectUri}' for client '${request.clientId}'`,
        { status: 400, code: 'invalid_request' },
      );
    }

    // PKCE is mandatory
    if (!request.codeChallenge) {
      throw new AuthError('code_challenge is required for PKCE', {
        status: 400,
        code: 'invalid_request',
      });
    }

    const method = request.codeChallengeMethod ?? 'S256';
    if (method !== 'S256' && method !== 'plain') {
      throw new AuthError(`Unsupported code_challenge_method '${method}'`, {
        status: 400,
        code: 'invalid_request',
      });
    }

    // Scopes validation
    const requestedScopes = request.scope ? request.scope.split(' ').filter(Boolean) : [];
    for (const scope of requestedScopes) {
      if (!client.allowedScopes.includes(scope)) {
        throw new AuthError(`Requested scope '${scope}' is not allowed for this client`, {
          status: 400,
          code: 'invalid_scope',
        });
      }
    }

    if (!currentSubjectId) {
      return { type: 'login_required', state: request.state };
    }

    // Authorization Manager policy check if configured
    if (this.authorizationManager) {
      const res = await this.authorizationManager.authorize(
        { sub: currentSubjectId, method: 'session', authTime: this.now() },
        { transport: 'oauth', metadata: { action: 'oauth:authorize', resource: request.clientId } },
      );
      const allowed = typeof res === 'boolean' ? res : res.allowed;
      if (!allowed) {
        throw new AuthError('Authorization policy denied OAuth authorization grant', {
          status: 403,
          code: 'access_denied',
        });
      }
    }

    // Check user consent
    const consent = await this.consentStore.getConsent(client.clientId, currentSubjectId);
    const missingScopes = requestedScopes.filter((s) => !consent?.scopes.includes(s));

    if (missingScopes.length > 0) {
      return {
        type: 'consent_required',
        client,
        scopes: requestedScopes,
        state: request.state,
      };
    }

    // Generate authorization code
    const codeString = crypto.randomUUID();
    const code: OAuthAuthorizationCode = {
      code: codeString,
      clientId: client.clientId,
      redirectUri: request.redirectUri,
      subjectId: currentSubjectId,
      scope: requestedScopes.join(' '),
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: method,
      nonce: request.nonce,
      expiresAt: this.now() + this.codeLifetimeSeconds,
      createdAt: this.now(),
    };

    await this.authCodeStore.createCode(code);

    return {
      type: 'redirect',
      redirectUri: request.redirectUri,
      code: codeString,
      state: request.state,
    };
  }

  /**
   * Save user consent decision.
   */
  async grantConsent(clientId: string, subjectId: string, scopes: string[]): Promise<OAuthConsent> {
    const consent: OAuthConsent = {
      clientId,
      subjectId,
      scopes,
      grantedAt: this.now(),
    };
    await this.consentStore.saveConsent(consent);
    return consent;
  }

  /**
   * Handle Token Endpoint (RFC 6749 §3.2).
   */
  async token(request: TokenRequest): Promise<OAuthTokenGrant> {
    if (request.grantType === 'authorization_code') {
      return this.handleAuthorizationCodeGrant(request);
    }
    if (request.grantType === 'refresh_token') {
      return this.handleRefreshTokenGrant(request);
    }
    throw new AuthError(`Unsupported grant_type '${request.grantType}'`, {
      status: 400,
      code: 'unsupported_grant_type',
    });
  }

  private async handleAuthorizationCodeGrant(request: TokenRequest): Promise<OAuthTokenGrant> {
    if (!request.code) {
      throw new AuthError('Missing code parameter', { status: 400, code: 'invalid_request' });
    }

    const code = await this.authCodeStore.consumeCode(request.code);
    if (!code) {
      throw new AuthError('Invalid or expired authorization code', {
        status: 400,
        code: 'invalid_grant',
      });
    }

    const at = this.now();
    if (code.expiresAt <= at) {
      throw new AuthError('Authorization code has expired', {
        status: 400,
        code: 'invalid_grant',
      });
    }

    // Client verification
    const client = await this.clientStore.getClient(code.clientId);
    if (!client) {
      throw new AuthError('Invalid client', { status: 400, code: 'invalid_client' });
    }

    if (request.clientId && request.clientId !== code.clientId) {
      throw new AuthError('client_id mismatch', { status: 400, code: 'invalid_grant' });
    }

    if (!client.isPublic && client.clientSecret) {
      if (request.clientSecret !== client.clientSecret) {
        throw new AuthError('Invalid client credentials', {
          status: 401,
          code: 'invalid_client',
        });
      }
    }

    // Redirect URI matching
    if (request.redirectUri && request.redirectUri !== code.redirectUri) {
      throw new AuthError('redirect_uri mismatch', { status: 400, code: 'invalid_grant' });
    }

    // PKCE Verification
    if (!request.codeVerifier) {
      throw new AuthError('code_verifier is required', { status: 400, code: 'invalid_grant' });
    }

    if (!isValidCodeVerifier(request.codeVerifier)) {
      throw new AuthError('Invalid code_verifier format', { status: 400, code: 'invalid_grant' });
    }

    let challenge: string;
    if (code.codeChallengeMethod === 'S256') {
      challenge = await computeS256Challenge(request.codeVerifier);
    } else {
      challenge = request.codeVerifier;
    }

    if (challenge !== code.codeChallenge) {
      throw new AuthError('PKCE code_verifier verification failed', {
        status: 400,
        code: 'invalid_grant',
      });
    }

    return this.issueTokens({
      clientId: code.clientId,
      subjectId: code.subjectId,
      scope: code.scope,
      nonce: code.nonce,
      allowedGrantTypes: client.allowedGrantTypes,
    });
  }

  private async handleRefreshTokenGrant(request: TokenRequest): Promise<OAuthTokenGrant> {
    if (!request.refreshToken) {
      throw new AuthError('Missing refresh_token parameter', {
        status: 400,
        code: 'invalid_request',
      });
    }

    const isRevoked = await this.tokenStore.isRevoked(request.refreshToken);
    if (isRevoked) {
      throw new AuthError('Refresh token is revoked or invalid', {
        status: 400,
        code: 'invalid_grant',
      });
    }

    const { record } = await this.keyService.signingKey();
    const verified = await verifyJwt(request.refreshToken, {
      algorithms: [record.algorithm as SignatureAlgorithm],
      key: (header) => this.keyService.verificationKey(header),
      issuer: this.issuer,
    });

    if (verified.claims['type'] !== 'refresh_token') {
      throw new AuthError('Invalid token type for refresh', {
        status: 400,
        code: 'invalid_grant',
      });
    }

    const clientId = verified.claims['client_id'] as string;
    const subjectId = verified.claims.sub as string;
    const scope = (request.scope || verified.claims['scope']) as string;

    const client = await this.clientStore.getClient(clientId);
    if (!client) {
      throw new AuthError('Invalid client', { status: 400, code: 'invalid_client' });
    }

    return this.issueTokens({
      clientId,
      subjectId,
      scope,
      allowedGrantTypes: client.allowedGrantTypes,
    });
  }

  private async issueTokens(options: {
    clientId: string;
    subjectId: string;
    scope: string;
    nonce?: string;
    allowedGrantTypes: string[];
  }): Promise<OAuthTokenGrant> {
    const { key, record } = await this.keyService.signingKey();

    const accessToken = await signJwt(
      {
        iss: this.issuer,
        sub: options.subjectId,
        aud: options.clientId,
        client_id: options.clientId,
        scope: options.scope,
        type: 'access_token',
      },
      {
        algorithm: record.algorithm as SignatureAlgorithm,
        key,
        kid: record.kid,
        expiresInSeconds: this.accessTokenLifetimeSeconds,
        now: this.now,
      },
    );

    const result: OAuthTokenGrant = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenLifetimeSeconds,
      scope: options.scope,
    };

    const scopes = options.scope.split(' ');
    if (scopes.includes('openid')) {
      const idToken = await signJwt(
        {
          iss: this.issuer,
          sub: options.subjectId,
          aud: options.clientId,
          ...(options.nonce ? { nonce: options.nonce } : {}),
          auth_time: this.now(),
        },
        {
          algorithm: record.algorithm as SignatureAlgorithm,
          key,
          kid: record.kid,
          expiresInSeconds: this.accessTokenLifetimeSeconds,
          now: this.now,
        },
      );
      result.id_token = idToken;
    }

    if (options.allowedGrantTypes.includes('refresh_token')) {
      const refreshToken = await signJwt(
        {
          iss: this.issuer,
          sub: options.subjectId,
          aud: options.clientId,
          client_id: options.clientId,
          scope: options.scope,
          type: 'refresh_token',
        },
        {
          algorithm: record.algorithm as SignatureAlgorithm,
          key,
          kid: record.kid,
          expiresInSeconds: this.refreshTokenLifetimeSeconds,
          now: this.now,
        },
      );

      result.refresh_token = refreshToken;

      const refreshRecord: OAuthRefreshTokenRecord = {
        token: refreshToken,
        clientId: options.clientId,
        subjectId: options.subjectId,
        scope: options.scope,
        expiresAt: this.now() + this.refreshTokenLifetimeSeconds,
        revoked: false,
      };

      await this.tokenStore.saveRefreshToken(refreshRecord);
    }

    return result;
  }

  /**
   * Revoke a refresh token (RFC 7009).
   */
  async revoke(tokenString: string): Promise<boolean> {
    return this.tokenStore.revokeToken(tokenString);
  }

  /**
   * UserInfo Endpoint (OIDC Core 1.0 §5.3).
   */
  async userinfo(
    accessToken: string,
    getClaims?: (subject: string) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { record } = await this.keyService.signingKey();
    const verified = await verifyJwt(accessToken, {
      algorithms: [record.algorithm as SignatureAlgorithm],
      key: (header) => this.keyService.verificationKey(header),
      issuer: this.issuer,
    });

    if (verified.claims['type'] !== 'access_token') {
      throw new AuthError('Token is not an access_token', {
        status: 401,
        code: 'invalid_token',
      });
    }

    const subject = verified.claims.sub!;
    const extraClaims = getClaims ? await getClaims(subject) : {};

    return {
      sub: subject,
      ...extraClaims,
    };
  }

  /**
   * OpenID Connect Discovery Metadata.
   */
  discovery(): OpenIDDiscoveryDocument {
    const base = this.issuer.endsWith('/') ? this.issuer.slice(0, -1) : this.issuer;
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      userinfo_endpoint: `${base}/oauth/userinfo`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email'],
    };
  }

  /**
   * Export public JWKS.
   */
  async jwks() {
    return this.keyService.publicJwks();
  }
}

export function createAuthorizationServer(
  options: OAuthAuthorizationServerOptions,
): AuthorizationServer {
  return new AuthorizationServer(options);
}
