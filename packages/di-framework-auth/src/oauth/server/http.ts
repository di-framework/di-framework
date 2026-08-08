import { AuthError } from '../../errors.ts';
import type { AuthorizationServer } from './server.ts';

export interface OAuthHttpHandlerOptions {
  server: AuthorizationServer;
  subjectResolver?: (request: Request) => Promise<string | undefined>;
  userinfoClaimsResolver?: (subject: string) => Promise<Record<string, unknown>>;
}

const COMMON_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Frame-Options': 'DENY',
  'Content-Type': 'application/json',
};

export async function handleOAuthServerRequest(
  request: Request,
  options: OAuthHttpHandlerOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const { server, subjectResolver, userinfoClaimsResolver } = options;

  try {
    // 1. Discovery Endpoint: GET /.well-known/openid-configuration
    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      return new Response(JSON.stringify(server.discovery()), {
        status: 200,
        headers: COMMON_SECURITY_HEADERS,
      });
    }

    // 2. JWKS Endpoint: GET /.well-known/jwks.json
    if (method === 'GET' && path === '/.well-known/jwks.json') {
      const jwks = await server.jwks();
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: COMMON_SECURITY_HEADERS,
      });
    }

    // 3. Authorization Endpoint: GET or POST /oauth/authorize
    if ((method === 'GET' || method === 'POST') && path === '/oauth/authorize') {
      const params =
        method === 'GET' ? url.searchParams : new URLSearchParams(await request.text());

      const subjectId = subjectResolver ? await subjectResolver(request) : undefined;
      const result = await server.authorize(
        {
          responseType: params.get('response_type') ?? '',
          clientId: params.get('client_id') ?? '',
          redirectUri: params.get('redirect_uri') ?? '',
          scope: params.get('scope') ?? undefined,
          state: params.get('state') ?? undefined,
          codeChallenge: params.get('code_challenge') ?? undefined,
          codeChallengeMethod:
            (params.get('code_challenge_method') as 'S256' | 'plain') ?? undefined,
          nonce: params.get('nonce') ?? undefined,
        },
        subjectId,
      );

      if (result.type === 'redirect') {
        const redirectUrl = new URL(result.redirectUri);
        redirectUrl.searchParams.set('code', result.code);
        if (result.state) redirectUrl.searchParams.set('state', result.state);
        return Response.redirect(redirectUrl.toString(), 302);
      }

      if (result.type === 'login_required') {
        return new Response(
          JSON.stringify({
            error: 'login_required',
            error_description: 'Authentication is required',
            state: result.state,
          }),
          { status: 401, headers: COMMON_SECURITY_HEADERS },
        );
      }

      return new Response(
        JSON.stringify({
          error: 'consent_required',
          error_description: 'User consent is required',
          client_id: result.client.clientId,
          scopes: result.scopes,
          state: result.state,
        }),
        { status: 200, headers: COMMON_SECURITY_HEADERS },
      );
    }

    // 4. Token Endpoint: POST /oauth/token
    if (method === 'POST' && path === '/oauth/token') {
      const bodyText = await request.text();
      let body: Record<string, string> = {};
      try {
        if (request.headers.get('content-type')?.includes('application/json')) {
          body = JSON.parse(bodyText);
        } else {
          const params = new URLSearchParams(bodyText);
          body = Object.fromEntries(params.entries());
        }
      } catch {
        throw new AuthError('Invalid request body', { status: 400, code: 'invalid_request' });
      }

      // Check Basic auth header for confidential clients
      const authHeader = request.headers.get('authorization');
      let clientId = body.client_id;
      let clientSecret = body.client_secret;

      if (authHeader?.startsWith('Basic ')) {
        const decoded = atob(authHeader.slice(6));
        const [id, secret] = decoded.split(':');
        if (id) clientId = id;
        if (secret) clientSecret = secret;
      }

      const grant = await server.token({
        grantType: body.grant_type ?? '',
        code: body.code,
        codeVerifier: body.code_verifier,
        redirectUri: body.redirect_uri,
        clientId,
        clientSecret,
        refreshToken: body.refresh_token,
        scope: body.scope,
      });

      return new Response(JSON.stringify(grant), {
        status: 200,
        headers: COMMON_SECURITY_HEADERS,
      });
    }

    // 5. Revocation Endpoint: POST /oauth/revoke
    if (method === 'POST' && path === '/oauth/revoke') {
      const bodyText = await request.text();
      const params = new URLSearchParams(bodyText);
      const token = params.get('token');
      if (token) {
        await server.revoke(token);
      }
      return new Response(null, { status: 200, headers: COMMON_SECURITY_HEADERS });
    }

    // 6. UserInfo Endpoint: GET or POST /oauth/userinfo or /userinfo
    if (
      (method === 'GET' || method === 'POST') &&
      (path === '/oauth/userinfo' || path === '/userinfo')
    ) {
      const authHeader = request.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'invalid_token', error_description: 'Missing Bearer token' }),
          { status: 401, headers: COMMON_SECURITY_HEADERS },
        );
      }
      const token = authHeader.slice(7);
      const userinfo = await server.userinfo(token, userinfoClaimsResolver);
      return new Response(JSON.stringify(userinfo), {
        status: 200,
        headers: COMMON_SECURITY_HEADERS,
      });
    }

    return null;
  } catch (error) {
    if (error instanceof AuthError) {
      const status = error.status || 400;
      return new Response(
        JSON.stringify({
          error: error.code || 'invalid_request',
          error_description: error.message,
        }),
        { status, headers: COMMON_SECURITY_HEADERS },
      );
    }
    return new Response(
      JSON.stringify({
        error: 'server_error',
        error_description: 'An internal server error occurred',
      }),
      { status: 500, headers: COMMON_SECURITY_HEADERS },
    );
  }
}
