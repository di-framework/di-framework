import { CommandFailure, type CliIo, type CommandResult } from '@di-framework/cli-extension';
import { generatePkce } from '@di-framework/auth/oauth';
import { parseAppCommandArgs } from './args';
import { requireController } from './controller-client';
import { CONTROLLER_HOST, resolveConnection, resolveTarget } from './target';
import { storeCredential } from './credentials';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { loadDeployManifest } from './manifest';
import { invalidUsage } from './support';


export const CLI_OAUTH_CLIENT_ID = 'di-framework-cli';

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export async function runWasmcloudLogin(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAppCommandArgs(args, 'wasmcloud login');
  if (options.name !== undefined) {
    invalidUsage(`Unexpected argument: ${options.name}`, options.name, { command: 'wasmcloud login' });
  }
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
  const controller = requireController(connection);

  let settle: (code: string) => void;
  let fail: (error: Error) => void;
  const gotCode = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const loopback = await deps.listenLoopback(async (request) => {
    const url = new URL(request.url);
    const error = url.searchParams.get('error');
    if (error !== null) {
      fail(new Error(error));
      return new Response(`Login failed: ${error}`, { status: 400, headers: { 'content-type': 'text/plain' } });
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      return new Response('Missing authorization code', { status: 400 });
    }
    settle(code);
    return new Response('Signed in. You can close this window.', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  try {
    const pkce = await generatePkce();
    const authorize = new URL('oauth/authorize', ensureSlash(controller.url));
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CLI_OAUTH_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', loopback.redirectUri);
    authorize.searchParams.set('scope', 'openid profile offline_access');
    authorize.searchParams.set('code_challenge', pkce.codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', 'cli');
    io.stdout.write(`Opening browser for wasmcloud login (${authorize.toString()})\n`);
    await deps.openUrl(authorize.toString());
    const code = await gotCode;
    const tokenUrl = new URL('oauth/token', ensureSlash(controller.url)).toString();
    const tokenResponse = await deps.fetch(tokenUrl, {
      method: 'POST',
      headers: {
        host: controller.host,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: loopback.redirectUri,
        client_id: CLI_OAUTH_CLIENT_ID,
        code_verifier: pkce.codeVerifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new CommandFailure(
        'WASMCLOUD_LOGIN_FAILED',
        `Token exchange failed (${tokenResponse.status})`,
        3,
        { status: tokenResponse.status, target: connection.target },
      );
    }
    const grant = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (typeof grant.access_token !== 'string' || grant.access_token === '') {
      throw new CommandFailure('WASMCLOUD_LOGIN_FAILED', 'Token response did not include access_token', 3, {
        target: connection.target,
      });
    }
    storeCredential(deps.credentialsPath(), connection.target, {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt:
        typeof grant.expires_in === 'number' ? Math.floor(Date.now() / 1000) + grant.expires_in : undefined,
      tokenType: grant.token_type,
      controller,
    });
    return {
      data: { target: connection.target, controller, host: controller.host ?? CONTROLLER_HOST },
      text: `Logged in to ${connection.target} (${controller.url}, Host: ${controller.host}).`,
    };
  } finally {
    await loopback.close();
  }
}
