import { clearCookie, OAUTH_STATE_COOKIE_NAME, readCookie, serializeCookie } from '../cookies.ts';
import { timingSafeEqualString } from '../crypto/compare.ts';
import { randomToken } from '../crypto/random.ts';
import { AuthError } from '../errors.ts';
import { createPrincipal } from '../principal.ts';
import type { StateStore } from '../providers/types.ts';
import type { SignatureAlgorithm } from '../tokens/algorithms.ts';
import { type RemoteJwks, remoteJwks } from '../tokens/jwks.ts';
import type { JwtClaims } from '../tokens/jwt.ts';
import { discovery, type OidcMetadata } from './discovery.ts';
import { validateIdToken } from './id-token.ts';
import { generatePkce } from './pkce.ts';
import type {
  AuthorizationRequest,
  CallbackResult,
  OAuthProfile,
  OAuthProvider,
  OAuthTokens,
} from './types.ts';

/**
 * OAuth 2.0 / OpenID Connect relying party.
 *
 * Implements the Authorization Code flow with PKCE and nothing else. The
 * security properties below are structural rather than configurable:
 *
 * - **PKCE S256 is mandatory.** There is no option to disable it.
 * - **No implicit or hybrid flow, no fragment response mode.** The client only
 *   ever reads `URL.searchParams` and never sends `response_mode`, so a token
 *   returned in a fragment is simply unreachable.
 * - **`state` is single-use** (enforced by `StateStore.consume`'s atomicity)
 *   *and* bound to the user agent by a cookie, per RFC 9700 §4.7.
 * - **Exact redirect-URI matching**, one URI per provider.
 */

export interface OAuthClient {
  authorizationUrl(input?: {
    scopes?: readonly string[];
    prompt?: string;
    loginHint?: string;
    maxAgeSeconds?: number;
    /** Where to send the user after a successful callback. Stored server-side. */
    returnTo?: string;
  }): Promise<AuthorizationRequest>;
  callback(request: Request): Promise<CallbackResult>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  userinfo(accessToken: string): Promise<Record<string, unknown>>;
  endSessionUrl(input: {
    idToken?: string;
    postLogoutRedirectUri?: string;
  }): Promise<string | null>;
  metadata(): Promise<OidcMetadata | null>;
}

export interface OAuthClientOptions {
  state: StateStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** `state` lifetime in seconds. Default 600. */
  stateTtlSeconds?: number;
}

interface OAuthState extends Record<string, unknown> {
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  returnTo?: string;
  maxAgeSeconds?: number;
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const;
const DEFAULT_ID_TOKEN_ALGS: readonly SignatureAlgorithm[] = ['RS256', 'ES256'];

function fail(
  message: string,
  code: 'oauth_error' | 'state_mismatch' | 'issuer_mismatch' | 'discovery_failed' | 'invalid_token',
  detail?: unknown,
): never {
  throw new AuthError(message, { code, status: 400, ...(detail !== undefined ? { detail } : {}) });
}

function defaultProfileMap(provider: OAuthProvider): NonNullable<OAuthProvider['profileMap']> {
  return (claims, userinfo) => {
    const source = { ...(claims ?? {}), ...(userinfo ?? {}) } as Record<string, unknown>;
    const subject = typeof source['sub'] === 'string' ? source['sub'] : '';
    return {
      subject,
      issuer: provider.issuer ?? provider.id,
      ...(typeof source['email'] === 'string' ? { email: source['email'] } : {}),
      ...(typeof source['email_verified'] === 'boolean'
        ? { emailVerified: source['email_verified'] }
        : {}),
      ...(typeof source['name'] === 'string' ? { name: source['name'] } : {}),
      ...(typeof source['picture'] === 'string' ? { picture: source['picture'] } : {}),
      raw: source,
    } satisfies OAuthProfile;
  };
}

export function oauthClient(provider: OAuthProvider, options: OAuthClientOptions): OAuthClient {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const stateTtl = options.stateTtlSeconds ?? 600;
  const isOidc = provider.oidc !== false;
  const scopes = provider.scopes ?? (isOidc ? DEFAULT_SCOPES : []);
  const idTokenAlgs = provider.idTokenSignedResponseAlg ?? DEFAULT_ID_TOKEN_ALGS;
  const profileMap = provider.profileMap ?? defaultProfileMap(provider);
  const statePurpose = `oauth-state:${provider.id}`;

  const discoveryClient = provider.issuer
    ? discovery(provider.issuer, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(provider.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      })
    : null;

  let jwksClient: RemoteJwks | undefined;

  const metadata = async (): Promise<OidcMetadata | null> =>
    discoveryClient ? discoveryClient.get() : null;

  const endpoint = async (
    name: 'authorization_endpoint' | 'token_endpoint' | 'userinfo_endpoint' | 'jwks_uri',
    override: string | undefined,
  ): Promise<string | null> => {
    if (override) return override;
    const document = await metadata();
    const value = document?.[name];
    return typeof value === 'string' ? value : null;
  };

  const requireEndpoint = async (
    name: 'authorization_endpoint' | 'token_endpoint',
    override: string | undefined,
  ): Promise<string> => {
    const value = await endpoint(name, override);
    if (!value) {
      fail(
        `Provider '${provider.id}' has no ${name}. Set it explicitly or provide an \`issuer\` for discovery.`,
        'discovery_failed',
      );
    }
    return value;
  };

  const jwks = async (): Promise<RemoteJwks> => {
    if (jwksClient) return jwksClient;
    const uri = await endpoint('jwks_uri', provider.jwksUri);
    if (!uri) fail(`Provider '${provider.id}' has no jwks_uri`, 'discovery_failed');
    jwksClient = remoteJwks(uri, options.fetch ? { fetch: options.fetch } : {});
    return jwksClient;
  };

  const tokenRequestHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (provider.clientAuth === 'client_secret_basic' && provider.clientSecret) {
      // RFC 6749 §2.3.1: both halves are form-urlencoded *before* base64. Almost
      // everyone skips this, and it only breaks for secrets containing `+`, `/`,
      // or `%` — which is exactly the kind of bug that surfaces months later
      // after a secret rotation.
      const credentials = `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`;
      headers['authorization'] = `Basic ${btoa(credentials)}`;
    }
    return headers;
  };

  const withClientAuth = (body: URLSearchParams): URLSearchParams => {
    body.set('client_id', provider.clientId);
    if (provider.clientAuth === 'client_secret_post' && provider.clientSecret) {
      body.set('client_secret', provider.clientSecret);
    }
    return body;
  };

  const parseTokenResponse = async (response: Response): Promise<OAuthTokens> => {
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      fail(`Token endpoint returned a non-JSON response (HTTP ${response.status})`, 'oauth_error');
    }

    if (!response.ok) {
      // The provider's `error_description` is attacker-influencable in some
      // flows, so it goes to `detail` (logs) and never to `publicMessage`.
      fail(`Token endpoint returned HTTP ${response.status}`, 'oauth_error', payload);
    }

    const accessToken = payload['access_token'];
    const tokenType = payload['token_type'];
    if (typeof accessToken !== 'string') fail('Token response has no access_token', 'oauth_error');
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      fail(`Token response token_type '${String(tokenType)}' is not Bearer`, 'oauth_error');
    }

    const scope = payload['scope'];
    return {
      accessToken,
      tokenType,
      ...(typeof payload['expires_in'] === 'number' ? { expiresIn: payload['expires_in'] } : {}),
      ...(typeof payload['refresh_token'] === 'string'
        ? { refreshToken: payload['refresh_token'] }
        : {}),
      ...(typeof payload['id_token'] === 'string' ? { idToken: payload['id_token'] } : {}),
      ...(typeof scope === 'string' ? { scope: scope.split(' ').filter(Boolean) } : {}),
    };
  };

  return {
    metadata,

    async authorizationUrl(input = {}) {
      const authorizationEndpoint = await requireEndpoint(
        'authorization_endpoint',
        provider.authorizationEndpoint,
      );

      const state = randomToken(32);
      const nonce = randomToken(32);
      const pkce = await generatePkce();
      const expiresAt = now() + stateTtl;

      await options.state.put({
        purpose: statePurpose,
        key: state,
        expiresAt,
        data: {
          nonce,
          codeVerifier: pkce.codeVerifier,
          redirectUri: provider.redirectUri,
          createdAt: now(),
          ...(input.returnTo ? { returnTo: input.returnTo } : {}),
          ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
        } satisfies OAuthState,
      });

      const url = new URL(authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('redirect_uri', provider.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
      const requestedScopes = input.scopes ?? scopes;
      if (requestedScopes.length > 0) url.searchParams.set('scope', requestedScopes.join(' '));
      if (isOidc) url.searchParams.set('nonce', nonce);
      if (input.prompt) url.searchParams.set('prompt', input.prompt);
      if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
      if (input.maxAgeSeconds !== undefined) {
        url.searchParams.set('max_age', String(input.maxAgeSeconds));
      }
      for (const [key, value] of Object.entries(provider.extraAuthorizationParams ?? {})) {
        url.searchParams.set(key, value);
      }
      // `response_mode` is never sent. The default is `query`, and reading only
      // `searchParams` is what structurally forbids the implicit flow.

      return {
        url: url.toString(),
        state,
        nonce,
        codeVerifier: pkce.codeVerifier,
        expiresAt,
        // SameSite=Lax, NOT Strict. The callback arrives as a top-level
        // cross-site GET navigation from the identity provider, which Strict
        // blocks — the cookie would silently not be sent and every single login
        // would fail with "state mismatch".
        stateCookie: serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
          maxAge: stateTtl,
          sameSite: 'Lax',
        }),
      };
    },

    async callback(request) {
      const url = new URL(request.url);
      const params = url.searchParams;

      const error = params.get('error');
      if (error) {
        fail(`Authorization server returned error '${error}'`, 'oauth_error', {
          error,
          description: params.get('error_description'),
          uri: params.get('error_uri'),
        });
      }

      const state = params.get('state');
      const code = params.get('code');
      if (!state) fail('Callback has no state parameter', 'state_mismatch');
      if (!code) fail('Callback has no code parameter', 'oauth_error');

      // Bind the callback to the browser that started the flow (RFC 9700 §4.7).
      // Without this, an attacker can complete a flow they started in the
      // victim's session — login CSRF.
      const cookieState = readCookie(request, OAUTH_STATE_COOKIE_NAME);
      if (!cookieState || !(await timingSafeEqualString(cookieState, state))) {
        fail('Callback state does not match the state cookie', 'state_mismatch');
      }

      // Atomic consume: this is what makes the authorization code callback
      // non-replayable.
      const entry = await options.state.consume<OAuthState>(statePurpose, state);
      if (!entry) fail('Authorization state expired or was already used', 'state_mismatch');
      const stored = entry.data;

      const document = await metadata();

      // RFC 9207: when the provider advertises the `iss` response parameter it
      // becomes required, and it is the authorization-server mix-up defence.
      const issParam = params.get('iss');
      if (document?.authorization_response_iss_parameter_supported && !issParam) {
        fail(
          'Provider advertises RFC 9207 but the callback has no iss parameter',
          'issuer_mismatch',
        );
      }
      if (issParam && provider.issuer && issParam !== provider.issuer) {
        fail(
          `Callback iss '${issParam}' does not match issuer '${provider.issuer}'`,
          'issuer_mismatch',
        );
      }

      const tokenEndpoint = await requireEndpoint('token_endpoint', provider.tokenEndpoint);
      const body = withClientAuth(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          // RFC 6749 §4.1.3: byte-identical to the value sent in the
          // authorization request, which is why it is read back from the store.
          redirect_uri: stored.redirectUri,
          code_verifier: stored.codeVerifier,
        }),
      );

      const tokens = await parseTokenResponse(
        await fetchImpl(tokenEndpoint, {
          method: 'POST',
          headers: tokenRequestHeaders(),
          body,
        }),
      );

      let idTokenClaims: JwtClaims | undefined;
      if (isOidc) {
        if (!tokens.idToken) fail('OIDC provider returned no id_token', 'oauth_error');
        if (!provider.issuer)
          fail(`Provider '${provider.id}' has no issuer to validate against`, 'discovery_failed');
        idTokenClaims = await validateIdToken(tokens.idToken, {
          issuer: provider.issuer,
          clientId: provider.clientId,
          nonce: stored.nonce,
          algorithms: idTokenAlgs,
          jwks: await jwks(),
          accessToken: tokens.accessToken,
          code,
          ...(stored.maxAgeSeconds !== undefined ? { maxAgeSeconds: stored.maxAgeSeconds } : {}),
          now,
        });
      }

      let userinfoClaims: Record<string, unknown> | null = null;
      const userinfoEndpoint = await endpoint('userinfo_endpoint', provider.userinfoEndpoint);
      if (userinfoEndpoint) {
        userinfoClaims = await this.userinfo(tokens.accessToken);
        // OIDC Core §5.3.2: the userinfo `sub` MUST match the ID token's.
        // Skipping this lets a confused or compromised userinfo endpoint swap
        // one identity for another after the token has already been validated.
        if (idTokenClaims && userinfoClaims['sub'] !== idTokenClaims.sub) {
          fail('Userinfo sub does not match the ID token sub', 'invalid_token');
        }
      }

      const profile = profileMap(idTokenClaims ?? null, userinfoClaims);
      if (!profile.subject) fail('Could not determine a subject for this identity', 'oauth_error');

      return {
        tokens,
        ...(idTokenClaims ? { idTokenClaims } : {}),
        profile,
        ...(stored.returnTo ? { returnTo: stored.returnTo } : {}),
        clearStateCookie: clearCookie(OAUTH_STATE_COOKIE_NAME, { sameSite: 'Lax' }),
        principal: createPrincipal({
          sub: profile.subject,
          method: 'oauth',
          issuer: profile.issuer,
          authTime:
            typeof idTokenClaims?.['auth_time'] === 'number'
              ? (idTokenClaims['auth_time'] as number)
              : now(),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
          ...(tokens.expiresIn !== undefined ? { expiresAt: now() + tokens.expiresIn } : {}),
          ...(idTokenClaims ? { claims: idTokenClaims } : {}),
        }),
      };
    },

    async refresh(refreshToken) {
      const tokenEndpoint = await requireEndpoint('token_endpoint', provider.tokenEndpoint);
      return parseTokenResponse(
        await fetchImpl(tokenEndpoint, {
          method: 'POST',
          headers: tokenRequestHeaders(),
          body: withClientAuth(
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
          ),
        }),
      );
    },

    async userinfo(accessToken) {
      const userinfoEndpoint = await endpoint('userinfo_endpoint', provider.userinfoEndpoint);
      if (!userinfoEndpoint)
        fail(`Provider '${provider.id}' has no userinfo_endpoint`, 'discovery_failed');

      const response = await fetchImpl(userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
      if (!response.ok) {
        fail(`Userinfo endpoint returned HTTP ${response.status}`, 'oauth_error');
      }
      const payload = (await response.json()) as unknown;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        fail('Userinfo response is not a JSON object', 'oauth_error');
      }
      return payload as Record<string, unknown>;
    },

    async endSessionUrl(input) {
      const document = await metadata();
      const endSessionEndpoint = document?.end_session_endpoint;
      if (typeof endSessionEndpoint !== 'string') return null;

      const url = new URL(endSessionEndpoint);
      url.searchParams.set('client_id', provider.clientId);
      if (input.idToken) url.searchParams.set('id_token_hint', input.idToken);
      if (input.postLogoutRedirectUri) {
        url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
      }
      return url.toString();
    },
  };
}
