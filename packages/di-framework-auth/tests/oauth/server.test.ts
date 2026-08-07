import { describe, expect, it, beforeEach } from 'bun:test';
import {
  AuthorizationServer,
  InMemoryAuthCodeStore,
  InMemoryClientStore,
  InMemoryConsentStore,
  InMemoryOAuthTokenStore,
  createAuthorizationServer,
  handleOAuthServerRequest,
} from '../../server.ts';
import { keyService } from '../../src/tokens/keystore.ts';
import { generatePkce } from '../../src/oauth/pkce.ts';
import type { KeyStore, SigningKeyRecord } from '../../src/providers/types.ts';

class MemoryKeyStore implements KeyStore {
  private records: SigningKeyRecord[] = [];
  async current(): Promise<SigningKeyRecord> {
    if (this.records.length === 0) throw new Error('No keys');
    return this.records[this.records.length - 1]!;
  }
  async save(record: SigningKeyRecord): Promise<SigningKeyRecord> {
    this.records.push(record);
    return record;
  }
  async find(kid: string): Promise<SigningKeyRecord | null> {
    return this.records.find((r) => r.kid === kid) ?? null;
  }
  async all(): Promise<SigningKeyRecord[]> {
    return this.records;
  }
  async delete(kid: string): Promise<boolean> {
    const idx = this.records.findIndex((r) => r.kid === kid);
    if (idx < 0) return false;
    this.records.splice(idx, 1);
    return true;
  }
}

describe('OAuth2 / OIDC Authorization Server', () => {
  let server: AuthorizationServer;
  let clientStore: InMemoryClientStore;
  let authCodeStore: InMemoryAuthCodeStore;
  let consentStore: InMemoryConsentStore;
  let tokenStore: InMemoryOAuthTokenStore;
  let keys: ReturnType<typeof keyService>;

  const issuer = 'https://auth.example.com';
  const clientConfig = {
    clientId: 'test-app',
    clientSecret: 'secret-123',
    clientName: 'Test App',
    redirectUris: ['https://app.example.com/callback'],
    allowedGrantTypes: ['authorization_code', 'refresh_token'],
    allowedScopes: ['openid', 'profile', 'email', 'read:docs'],
    isPublic: false,
  };

  beforeEach(async () => {
    clientStore = new InMemoryClientStore([clientConfig]);
    authCodeStore = new InMemoryAuthCodeStore();
    consentStore = new InMemoryConsentStore();
    tokenStore = new InMemoryOAuthTokenStore();
    keys = keyService({ store: new MemoryKeyStore() });

    server = createAuthorizationServer({
      issuer,
      keyService: keys,
      clientStore,
      authCodeStore,
      consentStore,
      tokenStore,
    });
  });

  it('generates discovery metadata and JWKS', async () => {
    const discovery = server.discovery();
    expect(discovery.issuer).toBe(issuer);
    expect(discovery.authorization_endpoint).toBe('https://auth.example.com/oauth/authorize');
    expect(discovery.token_endpoint).toBe('https://auth.example.com/oauth/token');
    expect(discovery.response_types_supported).toEqual(['code']);
    expect(discovery.code_challenge_methods_supported).toEqual(['S256']);

    // Bootstraps key lazily
    await keys.signingKey();
    const jwks = await server.jwks();
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it('covers store utility edge cases', async () => {
    const freshStore = new InMemoryClientStore();
    expect(await freshStore.getClient('test-app')).toBeNull();
    freshStore.registerClient(clientConfig);
    expect(await freshStore.getClient('test-app')).toEqual(clientConfig);

    expect(await authCodeStore.consumeCode('non-existent')).toBeNull();
    expect(await tokenStore.revokeToken('non-existent')).toBeFalse();
    expect(await tokenStore.isRevoked('non-existent')).toBeTrue();
  });

  it('rejects unsupported response_type and invalid clients', async () => {
    await expect(
      server.authorize({
        responseType: 'token',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: 'abc',
      }),
    ).rejects.toThrow('Unsupported response_type');

    await expect(
      server.authorize({
        responseType: 'code',
        clientId: 'non-existent',
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: 'abc',
      }),
    ).rejects.toThrow('Unknown client_id');
  });

  it('enforces exact redirect_uri matching and PKCE requirement', async () => {
    await expect(
      server.authorize({
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://attacker.example.com/callback',
        codeChallenge: 'abc',
      }),
    ).rejects.toThrow('Invalid redirect_uri');

    await expect(
      server.authorize({
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
      }),
    ).rejects.toThrow('code_challenge is required');
  });

  it('handles unauthenticated and unconsented requests', async () => {
    const pkce = await generatePkce();

    const loginReq = await server.authorize({
      responseType: 'code',
      clientId: 'test-app',
      redirectUri: 'https://app.example.com/callback',
      scope: 'openid profile',
      codeChallenge: pkce.codeChallenge,
      state: 'state-1',
    });
    expect(loginReq.type).toBe('login_required');

    const consentReq = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
        state: 'state-1',
      },
      'user-123',
    );
    expect(consentReq.type).toBe('consent_required');

    await server.grantConsent('test-app', 'user-123', ['openid', 'profile']);

    const redirectRes = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
        state: 'state-1',
      },
      'user-123',
    );
    expect(redirectRes.type).toBe('redirect');
    if (redirectRes.type === 'redirect') {
      expect(redirectRes.code).toBeDefined();
      expect(redirectRes.state).toBe('state-1');
    }
  });

  it('exchanges code for tokens with PKCE validation', async () => {
    const pkce = await generatePkce();
    await server.grantConsent('test-app', 'user-123', ['openid', 'profile']);

    const authResFailed = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      },
      'user-123',
    );
    const failedCode = (authResFailed as any).code;

    await expect(
      server.token({
        grantType: 'authorization_code',
        code: failedCode,
        codeVerifier: 'wrong-verifier-12345678901234567890123456789012345',
        clientId: 'test-app',
        clientSecret: 'secret-123',
        redirectUri: 'https://app.example.com/callback',
      }),
    ).rejects.toThrow('PKCE code_verifier verification failed');

    const authResSuccess = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
        nonce: 'nonce-777',
      },
      'user-123',
    );
    const code = (authResSuccess as any).code;

    const grant = await server.token({
      grantType: 'authorization_code',
      code,
      codeVerifier: pkce.codeVerifier,
      clientId: 'test-app',
      clientSecret: 'secret-123',
      redirectUri: 'https://app.example.com/callback',
    });

    expect(grant.token_type).toBe('Bearer');
    expect(grant.access_token).toBeDefined();
    expect(grant.refresh_token).toBeDefined();
    expect(grant.id_token).toBeDefined();

    await expect(
      server.token({
        grantType: 'authorization_code',
        code,
        codeVerifier: pkce.codeVerifier,
        clientId: 'test-app',
        clientSecret: 'secret-123',
      }),
    ).rejects.toThrow('Invalid or expired authorization code');
  });

  it('supports refresh token grant and revocation', async () => {
    const pkce = await generatePkce();
    await server.grantConsent('test-app', 'user-123', ['openid', 'profile']);

    const authRes = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
      },
      'user-123',
    );
    const code = (authRes as any).code;

    const grant = await server.token({
      grantType: 'authorization_code',
      code,
      codeVerifier: pkce.codeVerifier,
      clientId: 'test-app',
      clientSecret: 'secret-123',
    });

    const refreshed = await server.token({
      grantType: 'refresh_token',
      refreshToken: grant.refresh_token!,
    });
    expect(refreshed.access_token).toBeDefined();

    await server.revoke(grant.refresh_token!);

    await expect(
      server.token({
        grantType: 'refresh_token',
        refreshToken: grant.refresh_token!,
      }),
    ).rejects.toThrow('Refresh token is revoked or invalid');
  });

  it('returns userinfo for valid access token', async () => {
    const pkce = await generatePkce();
    await server.grantConsent('test-app', 'user-456', ['openid', 'profile']);

    const authRes = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid profile',
        codeChallenge: pkce.codeChallenge,
      },
      'user-456',
    );

    const grant = await server.token({
      grantType: 'authorization_code',
      code: (authRes as any).code,
      codeVerifier: pkce.codeVerifier,
      clientId: 'test-app',
      clientSecret: 'secret-123',
    });

    const info = await server.userinfo(grant.access_token, async (sub) => ({
      email: `${sub}@example.com`,
    }));

    expect(info.sub).toBe('user-456');
    expect(info.email).toBe('user-456@example.com');
  });

  it('serves endpoints via handleOAuthServerRequest HTTP router including all branches', async () => {
    const pkce = await generatePkce();

    // 1. Unauthenticated authorize -> login_required 401
    const unauthReq = new Request(
      `https://auth.example.com/oauth/authorize?response_type=code&client_id=test-app&redirect_uri=${encodeURIComponent(
        'https://app.example.com/callback',
      )}&code_challenge=${pkce.codeChallenge}&code_challenge_method=S256`,
    );
    const unauthRes = await handleOAuthServerRequest(unauthReq, { server });
    expect(unauthRes?.status).toBe(401);

    // 2. Unconsented authorize -> consent_required 200
    const unconsentedReq = new Request(
      `https://auth.example.com/oauth/authorize?response_type=code&client_id=test-app&redirect_uri=${encodeURIComponent(
        'https://app.example.com/callback',
      )}&code_challenge=${pkce.codeChallenge}&code_challenge_method=S256&scope=openid`,
    );
    const unconsentedRes = await handleOAuthServerRequest(unconsentedReq, {
      server,
      subjectResolver: async () => 'user-789',
    });
    expect(unconsentedRes?.status).toBe(200);
    const consentJson: any = await unconsentedRes?.json();
    expect(consentJson.error).toBe('consent_required');

    // 3. POST /oauth/authorize form-encoded
    await server.grantConsent('test-app', 'user-789', ['openid']);
    const postAuthReq = new Request('https://auth.example.com/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: 'test-app',
        redirect_uri: 'https://app.example.com/callback',
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        scope: 'openid',
        state: 'post-state',
      }).toString(),
    });
    const postAuthRes = await handleOAuthServerRequest(postAuthReq, {
      server,
      subjectResolver: async () => 'user-789',
    });
    expect(postAuthRes?.status).toBe(302);
    const location = postAuthRes?.headers.get('location');
    const code = new URL(location!).searchParams.get('code')!;

    // 4a. POST /oauth/token with form body
    const formTokenReq = new Request('https://auth.example.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce.codeVerifier,
        client_id: 'test-app',
        client_secret: 'secret-123',
        redirect_uri: 'https://app.example.com/callback',
      }).toString(),
    });
    const formTokenRes = await handleOAuthServerRequest(formTokenReq, { server });
    expect(formTokenRes?.status).toBe(200);
    const tokenData: any = await formTokenRes?.json();
    expect(tokenData.access_token).toBeDefined();

    // 4b. POST /oauth/token with JSON body & Basic auth header (generate a new code)
    const authRes2 = await server.authorize(
      {
        responseType: 'code',
        clientId: 'test-app',
        redirectUri: 'https://app.example.com/callback',
        scope: 'openid',
        codeChallenge: pkce.codeChallenge,
      },
      'user-789',
    );
    const code2 = (authRes2 as any).code;

    const basicAuth = btoa('test-app:secret-123');
    const jsonTokenReq = new Request('https://auth.example.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code2,
        code_verifier: pkce.codeVerifier,
        redirect_uri: 'https://app.example.com/callback',
      }),
    });
    const jsonTokenRes = await handleOAuthServerRequest(jsonTokenReq, { server });
    expect(jsonTokenRes?.status).toBe(200);

    // 5. POST /oauth/token with malformed JSON body
    const badJsonTokenReq = new Request('https://auth.example.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json-{',
    });
    const badJsonTokenRes = await handleOAuthServerRequest(badJsonTokenReq, { server });
    expect(badJsonTokenRes?.status).toBe(400);

    // 6. POST /oauth/revoke without token parameter and with token parameter
    const emptyRevokeReq = new Request('https://auth.example.com/oauth/revoke', {
      method: 'POST',
    });
    const emptyRevokeRes = await handleOAuthServerRequest(emptyRevokeReq, { server });
    expect(emptyRevokeRes?.status).toBe(200);

    const tokenRevokeReq = new Request('https://auth.example.com/oauth/revoke', {
      method: 'POST',
      body: new URLSearchParams({ token: tokenData.refresh_token }).toString(),
    });
    const tokenRevokeRes = await handleOAuthServerRequest(tokenRevokeReq, { server });
    expect(tokenRevokeRes?.status).toBe(200);

    // 7. GET /.well-known/jwks.json
    const jwksReq = new Request('https://auth.example.com/.well-known/jwks.json');
    const jwksRes = await handleOAuthServerRequest(jwksReq, { server });
    expect(jwksRes?.status).toBe(200);

    // 8. GET /oauth/userinfo with valid Bearer token
    const validUserinfoReq = new Request('https://auth.example.com/oauth/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const validUserinfoRes = await handleOAuthServerRequest(validUserinfoReq, {
      server,
      userinfoClaimsResolver: async (sub) => ({ email: `${sub}@example.com` }),
    });
    expect(validUserinfoRes?.status).toBe(200);
    const validUserinfoJson: any = await validUserinfoRes?.json();
    expect(validUserinfoJson.sub).toBe('user-789');
    expect(validUserinfoJson.email).toBe('user-789@example.com');

    // 9. GET /oauth/userinfo missing Bearer token header
    const noHeaderUserinfoReq = new Request('https://auth.example.com/oauth/userinfo');
    const noHeaderUserinfoRes = await handleOAuthServerRequest(noHeaderUserinfoReq, { server });
    expect(noHeaderUserinfoRes?.status).toBe(401);

    // 10. GET /unknown returns null
    const unknownReq = new Request('https://auth.example.com/unknown');
    const unknownRes = await handleOAuthServerRequest(unknownReq, { server });
    expect(unknownRes).toBeNull();

    // 11. Server throwing generic non-AuthError returns 500 server_error
    const throwingServer = new Proxy(server, {
      get(target, prop) {
        if (prop === 'discovery') throw new Error('Unexpected crash');
        return (target as any)[prop];
      },
    });
    const crashReq = new Request('https://auth.example.com/.well-known/openid-configuration');
    const crashRes = await handleOAuthServerRequest(crashReq, { server: throwingServer });
    expect(crashRes?.status).toBe(500);
    const crashJson: any = await crashRes?.json();
    expect(crashJson.error).toBe('server_error');
  });
});
